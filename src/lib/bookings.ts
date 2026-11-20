// Booking service: quote → hold → commit, plus every state change after it.
// Commits are serialized (a Postgres transaction holding the app-wide advisory lock, see db.ts) and
// re-verify every leg against a freshly rebuilt ledger, so double-booking cannot happen (§10).

import crypto from "node:crypto";
import QRCode from "qrcode";
import { db, tx } from "./db";
import { background } from "./background";
import { falseSellouts, quote, stillFits, type Block, type Leg, type Offer, type Product, type QuoteRequest } from "./engine";
import { HttpError } from "./http";
import { baseUrl, sendMessage } from "./messenger";
import { payments } from "./payments";
import { audit, buildLedger, getBookingByCode, getDayConfig, getLegs, getProduct, listRooms, upsertCustomer, type BookingRow } from "./repo";
import { emitChange } from "./events";
import { bookingToken } from "./auth";
import { AGE_BANDS } from "./waiver";
import { applyFlash, checkMemberHorizon } from "./yield";
import { assertWritable } from "./integrity";
export { AGE_BANDS };
import { addDays, fmtDay, fmtMin, istToEpoch, nowIST } from "./time";

export const HOLD_TTL_MS = 10 * 60_000;
export const PARTY_HOLD_TTL_MS = 2 * 60 * 60_000;
export const NO_SHOW_GRACE_MIN = 10;
export const WAITLIST_OFFER_MS = 10 * 60_000;
export const PARTY_LEAD_MS = 48 * 60 * 60_000;
export const BOOKING_HORIZON_DAYS = 60;

export type PaymentMode = "online" | "cash" | "upi_counter" | "membership" | "comp";
export type Source = "online" | "desk" | "phone";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
async function genCode(): Promise<string> {
  const d = db();
  for (;;) {
    let c = "WON-";
    const bytes = crypto.randomBytes(4);
    for (const b of bytes) c += CODE_ALPHABET[b % CODE_ALPHABET.length];
    if (!(await d.prepare("SELECT 1 FROM bookings WHERE code = ?").get(c))) return c;
  }
}

/** Fire-and-forget (WhatsApp sends): runs after the response, outside any transaction. */
function fire(task: () => Promise<unknown>) {
  background(task);
}

/** Run the waitlist after the current transaction/request settles, never inside a commit. */
function kickWaitlist() {
  background(processWaitlist);
}

// ---------------------------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------------------------

export interface QuoteInput {
  day: string;
  productId: string;
  party: number;
  preferredMin?: number | null;
  chosenRooms?: string[] | null;
  channel: "online" | "desk";
  exactStart?: number | null;
  windowStart?: number | null;
  windowEnd?: number | null;
  excludeBookingId?: number;
  limit?: number;
  /** Customer/desk searches: record a rejection (no offers) for the §12 false sell-out KPI. */
  logRejection?: boolean;
}

export async function quoteDay(input: QuoteInput) {
  const { day: today, min } = nowIST();
  if (input.day < today) throw new HttpError(400, "That date has passed");
  if (input.day > addDays(today, BOOKING_HORIZON_DAYS)) throw new HttpError(400, `Bookings open ${BOOKING_HORIZON_DAYS} days ahead`);
  await sweep();
  const [product, ledger] = await Promise.all([
    getProduct(input.productId, input.day),
    buildLedger(input.day, { excludeBookingId: input.excludeBookingId }),
  ]);
  if (!product) throw new HttpError(404, "Unknown product");
  if (product.shape === "party" && input.channel === "online") throw new HttpError(400, "Parties are booked through our party desk — call or WhatsApp us");
  const isToday = input.day === today;
  const req: QuoteRequest = {
    productId: input.productId,
    party: input.party,
    preferredMin: input.preferredMin ?? null,
    chosenRooms: input.chosenRooms ?? null,
    channel: input.channel,
    exactStart: input.exactStart ?? null,
    windowStart: input.windowStart ?? null,
    windowEnd: input.windowEnd ?? null,
    nowMin: isToday ? min : null,
    notBefore: isToday ? min : null,
    limit: input.limit,
  };
  const result = quote(ledger, product, req);
  await applyFlash(input.day, product, input.party, result.offers, ledger.cfg.peakHours);
  if (input.logRejection && !result.error && result.offers.length === 0) {
    const bad = falseSellouts(ledger, product, req);
    if (bad > 0) console.error(`[won] FALSE SELL-OUT: ${product.id} x${input.party} on ${input.day} — ${bad} start(s) had capacity but no assignment`);
    await db().prepare("INSERT INTO quote_rejections (day, product_id, party, channel, false_sellout, at) VALUES (?, ?, ?, ?, ?, ?)").run(input.day, product.id, input.party, input.channel, bad > 0 ? 1 : 0, Date.now());
  }
  return { product, ledger, result };
}

/** §8.4 Upsell from real availability: could this same start seat them for 3 games or All 5? */
export async function upsellsFor(day: string, product: Product, party: number, start: number, channel: "online" | "desk") {
  const out: { productId: string; name: string; start: number; extraPaise: number }[] = [];
  const tries = product.id === "c1" ? ["c3", "a5"] : product.id === "c3" ? ["a5", "combo"] : [];
  for (const pid of tries) {
    const p = await getProduct(pid);
    if (!p || !p.active || party > p.maxParty || party < p.minParty) continue;
    const at = p.shape === "rotation" ? Math.floor(start / 60) * 60 : start;
    try {
      const { result } = await quoteDay({ day, productId: pid, party, channel, exactStart: p.shape === "combo" ? null : at, windowStart: p.shape === "combo" ? start - 20 : null, windowEnd: p.shape === "combo" ? start + 21 : null, limit: 1 });
      const o = result.offers[0];
      if (o) out.push({ productId: pid, name: p.name, start: o.start, extraPaise: o.pricePaise - product.pricePaise * party });
    } catch {
      /* not offerable */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sweeps: hold expiry, auto no-show, done, waitlist offer expiry. Timestamp checks, not a job that can die.
// ---------------------------------------------------------------------------------------------

let lastSweep = 0;
export async function sweep(force = false) {
  const t = Date.now();
  if (!force && t - lastSweep < 2000) return;
  lastSweep = t;
  const d = db();
  const { day: today, min } = nowIST();
  const released: { day: string; start_min: number }[] = [];

  // Each transition is a single conditional UPDATE … RETURNING, so two instances sweeping at once
  // can't both claim (and audit) the same booking.
  const expired = (await d
    .prepare("UPDATE bookings SET status = 'expired' WHERE status = 'hold' AND hold_expires < ? RETURNING id, day, start_min")
    .run<{ id: number; day: string; start_min: number }>(t)).rows;
  released.push(...expired);

  const noShows = (await d
    .prepare("UPDATE bookings SET status = 'no_show' WHERE status = 'confirmed' AND (day < ? OR (day = ? AND start_min + ? < ?)) RETURNING id, code, day, start_min")
    .run<{ id: number; code: string; day: string; start_min: number }>(today, today, NO_SHOW_GRACE_MIN, min)).rows;
  for (const n of noShows) {
    await audit("system", "auto_no_show", n.code, { graceMin: NO_SHOW_GRACE_MIN });
    released.push(n);
  }
  await d.prepare("UPDATE bookings SET status = 'done' WHERE status = 'arrived' AND (day < ? OR (day = ? AND end_min < ?))").run(today, today, min);
  await d.prepare("UPDATE waitlist SET state = 'expired' WHERE state = 'offered' AND offer_expires < ?").run(t);
  await d.prepare("UPDATE waitlist SET state = 'expired' WHERE state = 'waiting' AND (day < ? OR (day = ? AND hour * 60 + 60 <= ?))").run(today, today, min);

  const days = new Set(released.map((r) => r.day));
  for (const day of days) emitChange(day);
  if (released.length || expired.length) kickWaitlist();
}

// ---------------------------------------------------------------------------------------------
// Holds & commits
// ---------------------------------------------------------------------------------------------

export interface HoldInput {
  day: string;
  productId: string;
  party: number;
  start: number;
  chosenRooms?: string[] | null;
  name: string;
  phone: string;
  /** Lead guest's age and gender (desk bookings). */
  age?: number | null;
  gender?: string | null;
  source: Source;
  payment: PaymentMode;
  idemKey?: string | null;
  guestNames?: string[];
  food?: boolean;
  notes?: string;
  actor: string;
  membershipId?: number | null;
  overridePartyLead?: boolean;
}

export interface HoldResult {
  code: string;
  status: string;
  holdExpires: number | null;
  amountDuePaise: number;
  pricePaise: number;
  order: { provider: string; orderId: string; keyId: string | null } | null;
  token: string;
}

async function alternatives(day: string, productId: string, party: number, around: number, channel: "online" | "desk") {
  try {
    return (await quoteDay({ day, productId, party, channel, preferredMin: around, limit: 3 })).result.offers.map((o) => ({ start: o.start, end: o.end }));
  } catch {
    return [];
  }
}

export async function createHold(input: HoldInput): Promise<HoldResult> {
  const d = db();
  if (input.idemKey) {
    const existing = await d.prepare("SELECT code FROM bookings WHERE idem_key = ?").get<{ code: string }>(input.idemKey);
    if (existing) return holdResultFor(existing.code);
  }
  await assertWritable();
  const channel = input.source === "online" ? "online" : "desk";
  const product = await getProduct(input.productId, input.day);
  if (!product) throw new HttpError(404, "Unknown product");

  if (product.shape === "party") {
    const lead = istToEpoch(input.day, input.start) - Date.now();
    if (lead < PARTY_LEAD_MS && !input.overridePartyLead) throw new HttpError(400, "Parties need at least 48 h notice (manager override available)");
  }
  if (input.payment === "membership") {
    await validateMembership(input.membershipId ?? null, input.phone, input.day);
    await checkMemberHorizon(input.day, input.start);
  }

  const customerId = await upsertCustomer(input.phone, input.name, { age: input.age, gender: input.gender });
  const isOnlinePay = input.payment === "online";
  const ttl = product.shape === "party" ? PARTY_HOLD_TTL_MS : HOLD_TTL_MS;

  const commit = async (): Promise<{ code: string; offer: Offer; due: number }> => {
    // Idempotency re-checked under the lock: a retried request racing the original must not book twice.
    if (input.idemKey) {
      const again = await d.prepare("SELECT code FROM bookings WHERE idem_key = ?").get<{ code: string }>(input.idemKey);
      if (again) throw new IdemHit(again.code);
    }
    // Re-quote at the exact start under the lock — never trust client-supplied legs.
    const { result } = await quoteDay({ day: input.day, productId: input.productId, party: input.party, chosenRooms: input.chosenRooms, channel, exactStart: input.start, limit: 1 });
    if (result.error) throw new HttpError(400, result.error);
    const offer = result.offers[0];
    if (!offer) {
      throw new HttpError(409, "Sorry — that slot was just taken.", { alternatives: await alternatives(input.day, input.productId, input.party, input.start, channel) });
    }
    const code = await genCode();
    const price = input.payment === "membership" || input.payment === "comp" ? 0 : offer.pricePaise;
    const deposit = product.shape === "party" ? Math.round(price * 0.25) : 0;
    const due = product.shape === "party" ? deposit : price;
    const status = isOnlinePay && due > 0 ? "hold" : "confirmed";
    const guests = (input.guestNames ?? []).filter(Boolean).map((name) => ({ name }));
    const info = await d
      .prepare(
        `INSERT INTO bookings (code, product_id, customer_id, day, start_min, end_min, party_size, guest_list, status, source, price_paise, deposit_paise, paid_paise, payment_method, idem_key, hold_expires, food, notes, membership_id, created_at)
         VALUES (@code, @product_id, @customer_id, @day, @start, @end, @party, @guests, @status, @source, @price, @deposit, @paid, @method, @idem, @expires, @food, @notes, @membership, @created)
         RETURNING id`,
      )
      .run<{ id: number }>({
        code, product_id: product.id, customer_id: customerId, day: input.day, start: offer.start, end: offer.end, party: input.party,
        guests: JSON.stringify(guests), status, source: input.source, price, deposit,
        paid: status === "confirmed" && !isOnlinePay ? due : 0,
        method: input.payment, idem: input.idemKey ?? null, expires: status === "hold" ? Date.now() + ttl : null,
        food: input.food ? 1 : 0, notes: input.notes ?? "", membership: input.payment === "membership" ? input.membershipId ?? null : null, created: Date.now(),
      });
    const id = info.rows[0].id;
    await insertLegs(id, input.day, offer.legs, offer.blocks ?? []);
    await audit(input.actor, status === "hold" ? "hold_created" : "booking_created", code, { product: product.id, party: input.party, start: offer.start, payment: input.payment, source: input.source });
    return { code, offer, due };
  };

  let committed: { code: string; due: number };
  try {
    committed = await tx(commit);
  } catch (e) {
    if (e instanceof IdemHit) return holdResultFor(e.code);
    throw e;
  }
  const { code, due } = committed;
  const booking = (await getBookingByCode(code))!;
  emitChange(input.day);

  if (booking.status === "hold") {
    try {
      const pp = payments();
      const { orderId } = await pp.createOrder(due, code);
      await d.prepare("INSERT INTO payments (booking_id, provider, provider_order_id, amount_paise, status, kind, created_at) VALUES (?, ?, ?, ?, 'created', ?, ?)").run(
        booking.id, pp.name, orderId, due, product.shape === "party" ? "deposit" : "booking", Date.now(),
      );
    } catch (e) {
      await d.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
      emitChange(input.day);
      console.error(e);
      throw new HttpError(502, "Payment gateway unavailable — please try again");
    }
  } else {
    await afterConfirm(booking.id);
  }
  return holdResultFor(code);
}

/** Thrown inside the commit when the idempotency key was used meanwhile; rolls back, returns the original. */
class IdemHit extends Error {
  constructor(public code: string) {
    super("idempotent replay");
  }
}

async function insertLegs(bookingId: number, day: string, legs: Leg[], blocks: Block[]) {
  const d = db();
  const ins = d.prepare("INSERT INTO booking_legs (booking_id, leg_no, room_id, day, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [i, l] of legs.entries()) await ins.run(bookingId, i, l.roomId, day, l.start, l.end);
  const insB = d.prepare("INSERT INTO calendar_blocks (room_id, day, start_min, end_min, reason, booking_id) VALUES (?, ?, ?, ?, ?, ?)");
  for (const b of blocks) await insB.run(b.roomId, day, b.start, b.end, b.reason, bookingId);
}

export async function holdResultFor(code: string): Promise<HoldResult> {
  const b = await getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  const p = await db()
    .prepare("SELECT * FROM payments WHERE booking_id = ? ORDER BY id DESC LIMIT 1")
    .get<{ provider: string; provider_order_id: string; amount_paise: number; status: string }>(b.id);
  const due = b.status === "hold" ? (p?.amount_paise ?? 0) : 0;
  return {
    code: b.code,
    status: b.status,
    holdExpires: b.hold_expires,
    amountDuePaise: due,
    pricePaise: b.price_paise,
    order: p && b.status === "hold" ? { provider: p.provider, orderId: p.provider_order_id, keyId: payments().publicKey } : null,
    token: bookingToken(b.code),
  };
}

/**
 * The single code path where money and seats can disagree (§5). Called by the Razorpay webhook,
 * the checkout-signature fallback, and the mock gateway. Idempotent on provider_payment_id.
 */
export async function handlePaymentCaptured(orderId: string, paymentId: string, amountPaise: number | null, raw: unknown) {
  const d = db();
  const pay = await d
    .prepare("SELECT * FROM payments WHERE provider_order_id = ?")
    .get<{ id: number; booking_id: number; status: string; amount_paise: number; provider_payment_id: string | null; kind: string }>(orderId);
  if (!pay) return { ok: false, reason: "unknown order" };
  if (pay.status === "captured" || pay.status === "refunded") return { ok: true, deduped: true };
  if (await d.prepare("SELECT 1 FROM payments WHERE provider_payment_id = ?").get(paymentId)) return { ok: true, deduped: true };

  const amount = amountPaise ?? pay.amount_paise;

  // Webhook + checkout fallback can arrive together: the capture is claimed under the lock, once.
  const outcome = await tx(async (): Promise<"confirmed" | "already" | "refund" | "deduped"> => {
    const claimed = await d
      .prepare("UPDATE payments SET status = 'captured', provider_payment_id = ?, raw = ? WHERE id = ? AND status NOT IN ('captured','refunded')")
      .run(paymentId, JSON.stringify(raw ?? {}), pay.id);
    if (!claimed.changes) return "deduped";
    const b = (await d.prepare("SELECT * FROM bookings WHERE id = ?").get<BookingRow>(pay.booking_id))!;
    if (["confirmed", "arrived", "done"].includes(b.status)) {
      await d.prepare("UPDATE bookings SET paid_paise = paid_paise + ? WHERE id = ?").run(amount, b.id);
      return "already";
    }
    const live = b.status === "hold" && (b.hold_expires ?? 0) >= Date.now();
    if (!live) {
      // Late payment (slow UPI): retry the commit against the current ledger.
      const [product, ledger, legRows, blockRows] = await Promise.all([
        getProduct(b.product_id),
        buildLedger(b.day, { excludeBookingId: b.id }),
        getLegs(b.id),
        d.prepare("SELECT room_id, start_min, end_min, reason FROM calendar_blocks WHERE booking_id = ?").all<{ room_id: string; start_min: number; end_min: number; reason: string }>(b.id),
      ]);
      const legs = legRows.map((l) => ({ roomId: l.room_id, start: l.start_min, end: l.end_min }));
      const blocks = blockRows.map((x) => ({ roomId: x.room_id, start: x.start_min, end: x.end_min, reason: x.reason }));
      if (!stillFits(ledger, product!, b.party_size, legs, blocks)) {
        await d.prepare("UPDATE bookings SET status = 'cancelled', notes = notes || ' [auto-refunded: seats gone after late payment]' WHERE id = ?").run(b.id);
        return "refund";
      }
    }
    await d.prepare("UPDATE bookings SET status = 'confirmed', hold_expires = NULL, paid_paise = paid_paise + ? WHERE id = ?").run(amount, b.id);
    return "confirmed";
  });
  if (outcome === "deduped") return { ok: true, deduped: true };

  const b = (await d.prepare("SELECT * FROM bookings WHERE id = ?").get<BookingRow>(pay.booking_id))!;
  if (outcome === "refund") {
    try {
      const { refundId } = await payments().refund(paymentId, amount);
      await d
        .prepare("UPDATE payments SET status = 'refunded', raw = (COALESCE(raw, '{}')::jsonb || jsonb_build_object('refund_id', ?::text))::text WHERE id = ?")
        .run(refundId, pay.id);
    } catch (e) {
      await audit("system", "refund_failed", b.code, { error: String(e) });
    }
    await audit("system", "late_payment_refunded", b.code, { paymentId, amount });
    const cust = await customerOf(b);
    if (cust) {
      const alts = await alternatives(b.day, b.product_id, b.party_size, b.start_min, "online");
      fire(() => sendMessage(cust.phone, "booking_apology", {
        name: cust.name || "there",
        code: b.code,
        alternatives: alts.map((a) => fmtMin(a.start)).join(", ") || "none today",
        link: `${baseUrl()}/`,
      }));
    }
    emitChange(b.day);
    return { ok: true, refunded: true, code: b.code };
  }
  if (outcome === "confirmed") await afterConfirm(b.id);
  return { ok: true, code: b.code };
}

export async function handlePaymentFailed(orderId: string) {
  const d = db();
  const pay = await d.prepare("SELECT booking_id FROM payments WHERE provider_order_id = ?").get<{ booking_id: number }>(orderId);
  if (!pay) return;
  await d.prepare("UPDATE payments SET status = 'failed' WHERE provider_order_id = ? AND status = 'created'").run(orderId);
  const released = await d
    .prepare("UPDATE bookings SET status = 'expired' WHERE id = ? AND status = 'hold' RETURNING code, day")
    .run<{ code: string; day: string }>(pay.booking_id);
  const b = released.rows[0];
  if (b) {
    await audit("system", "hold_released_payment_failed", b.code);
    emitChange(b.day);
    kickWaitlist();
  }
}

async function customerOf(b: BookingRow) {
  return b.customer_id ? ((await db().prepare("SELECT * FROM customers WHERE id = ?").get<{ id: number; phone: string; name: string }>(b.customer_id)) ?? null) : null;
}

async function afterConfirm(bookingId: number) {
  const d = db();
  const b = (await d.prepare("SELECT * FROM bookings WHERE id = ?").get<BookingRow>(bookingId))!;
  await ensureInvoice(b);
  const [p, cust] = await Promise.all([getProduct(b.product_id), customerOf(b)]);
  await audit("system", "booking_confirmed", b.code, { paid: b.paid_paise });
  emitChange(b.day);
  if (cust && p) {
    fire(() => sendMessage(cust.phone, "booking_confirmed", {
      name: cust.name || "there",
      product: p.name,
      when: `${fmtDay(b.day)}, ${fmtMin(b.start_min)}`,
      code: b.code,
      link: `${baseUrl()}/b/${b.code}?t=${bookingToken(b.code)}`,
      waivers: `${baseUrl()}/w/${b.code}?t=${bookingToken(b.code)}`,
      directions: "Level 6, AMB Mall",
    }));
  }
}

function financialYear(at: number) {
  const { day } = nowIST(at);
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

async function ensureInvoice(b: BookingRow) {
  const d = db();
  if (b.price_paise <= 0) return;
  const fy = financialYear(Date.now());
  // Sequential GST numbers: allocated under the lock, and re-checked there so a booking gets one invoice.
  await tx(async () => {
    if (await d.prepare("SELECT 1 FROM invoices WHERE booking_id = ?").get(b.id)) return;
    const seq = ((await d.prepare("SELECT MAX(seq) AS s FROM invoices WHERE fy = ?").get<{ s: number | null }>(fy))!.s ?? 0) + 1;
    const taxable = Math.round(b.price_paise / 1.18);
    const gst = b.price_paise - taxable;
    const detail = { total: b.price_paise, taxable, cgst: Math.floor(gst / 2), sgst: gst - Math.floor(gst / 2), rate: 18, inclusive: true };
    await d.prepare("INSERT INTO invoices (booking_id, number, fy, seq, gst_detail, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      b.id, `WON/${fy}/${String(seq).padStart(5, "0")}`, fy, seq, JSON.stringify(detail), Date.now(),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Check-in, no-show, cancel, reschedule
// ---------------------------------------------------------------------------------------------

/** Accepts a raw code, "WON:CODE:TOKEN" QR payload, or a /b/CODE?t=… URL. */
export function parseScan(input: string): string {
  const s = input.trim();
  const m = s.match(/WON-[A-Z0-9]{4}/i);
  if (!m) throw new HttpError(400, "Not a WON booking code");
  return m[0].toUpperCase();
}

export async function waiverCount(bookingId: number): Promise<number> {
  return (await db().prepare("SELECT COUNT(*) AS n FROM waivers WHERE booking_id = ?").get<{ n: number }>(bookingId))!.n;
}

export async function checkIn(scan: string, actor: string, opts: { shrinkTo?: number | null } = {}) {
  await sweep(true);
  const d = db();
  const b = await getBookingByCode(parseScan(scan));
  if (!b) throw new HttpError(404, "Booking not found");
  const { day: today } = nowIST();
  if (b.status === "arrived") throw new HttpError(409, "Already checked in");
  if (b.day !== today) throw new HttpError(409, `This booking is for ${fmtDay(b.day)}`);
  if (b.status === "no_show") {
    // Late arrival after the auto no-show: allowed only if their seats were not resold.
    const product = (await getProduct(b.product_id))!;
    const ledger = await buildLedger(b.day, { excludeBookingId: b.id });
    const { min } = nowIST();
    const legs = (await getLegs(b.id)).map((l) => ({ roomId: l.room_id, start: l.start_min, end: l.end_min })).filter((l) => l.end > min);
    if (legs.length === 0 || !stillFits(ledger, product, b.party_size, legs)) throw new HttpError(409, "Marked no-show and the slot has been resold — offer a new slot via walk-in");
  } else if (b.status !== "confirmed") throw new HttpError(409, `Booking is ${b.status.replace("_", "-")}`);
  const signed = await waiverCount(b.id);
  let party = b.party_size;
  if (signed < party) {
    if (!opts.shrinkTo) throw new HttpError(409, "Waivers missing", { needWaivers: true, signed, party, lead: (await customerOf(b))?.name ?? "" });
    if (opts.shrinkTo < 1 || opts.shrinkTo > signed) throw new HttpError(400, `Can check in at most ${signed} guest(s) with signed waivers`);
    party = opts.shrinkTo;
  }
  await tx(async () => {
    // Claim the check-in: a double scan at two counters must not burn two membership visits.
    const claimed = await d
      .prepare("UPDATE bookings SET status = 'arrived', arrived_at = ?, party_size = ? WHERE id = ? AND status = ?")
      .run(Date.now(), party, b.id, b.status);
    if (!claimed.changes) throw new HttpError(409, "Already checked in");
    if (party !== b.party_size) await audit(actor, "party_shrunk_at_checkin", b.code, { from: b.party_size, to: party, reason: "unsigned waivers" });
    if (b.membership_id) await burnMembershipVisit(b.membership_id, b.id);
    await audit(actor, "checked_in", b.code, { party });
  });
  emitChange(b.day);
  if (party !== b.party_size) kickWaitlist();
  return { code: b.code, party };
}

export async function markNoShow(code: string, actor: string, reason: string) {
  const b = await getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  if (b.status !== "confirmed") throw new HttpError(409, `Booking is ${b.status}`);
  await db().prepare("UPDATE bookings SET status = 'no_show' WHERE id = ?").run(b.id);
  await audit(actor, "manual_no_show", b.code, { reason });
  emitChange(b.day);
  kickWaitlist();
}

export async function cancelBooking(code: string, actor: string, reason: string) {
  const b = await getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  if (!["hold", "confirmed"].includes(b.status)) throw new HttpError(409, `Booking is ${b.status}`);
  await db().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
  await audit(actor, "cancelled_override", b.code, { reason, paid: b.paid_paise, note: "No refund per policy unless owner-approved" });
  emitChange(b.day);
  kickWaitlist();
}

export async function reschedule(code: string, newDay: string, newStart: number, actor: string, opts: { override: boolean; reason?: string }) {
  const d = db();
  const b = await getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  if (b.status !== "confirmed") throw new HttpError(409, `Only confirmed bookings can be moved (this one is ${b.status})`);
  await assertWritable();
  if (!opts.override) {
    if (b.reschedule_count >= 1) throw new HttpError(403, "The one free reschedule has been used — please contact the desk");
    if (istToEpoch(b.day, b.start_min) - Date.now() < 24 * 60 * 60_000) throw new HttpError(403, "Free reschedules close 24 h before your slot");
  }
  const product = (await getProduct(b.product_id))!;
  const oldDay = b.day;
  await tx(async () => {
    // Re-read under the lock: a concurrent move must not use the one free reschedule twice.
    const cur = (await d.prepare("SELECT status, reschedule_count FROM bookings WHERE id = ?").get<{ status: string; reschedule_count: number }>(b.id))!;
    if (cur.status !== "confirmed") throw new HttpError(409, `Only confirmed bookings can be moved (this one is ${cur.status})`);
    if (!opts.override && cur.reschedule_count >= 1) throw new HttpError(403, "The one free reschedule has been used — please contact the desk");
    const { result } = await quoteDay({ day: newDay, productId: b.product_id, party: b.party_size, channel: "desk", exactStart: newStart, excludeBookingId: b.id, limit: 1 });
    const offer = result.offers[0];
    if (!offer) throw new HttpError(409, "That slot isn't available");
    if (offer.pricePaise > b.price_paise && !opts.override && b.price_paise > 0) throw new HttpError(409, "Reschedules are limited to equal-value slots");
    await d.prepare("DELETE FROM booking_legs WHERE booking_id = ?").run(b.id);
    await d.prepare("DELETE FROM calendar_blocks WHERE booking_id = ?").run(b.id);
    await insertLegs(b.id, newDay, offer.legs, offer.blocks ?? []);
    await d.prepare("UPDATE bookings SET day = ?, start_min = ?, end_min = ?, reschedule_count = reschedule_count + 1 WHERE id = ?").run(newDay, offer.start, offer.end, b.id);
    await audit(actor, opts.override ? "reschedule_override" : "rescheduled", b.code, { from: { day: oldDay, start: b.start_min }, to: { day: newDay, start: offer.start }, reason: opts.reason ?? null, product: product.id });
  });
  emitChange(oldDay);
  emitChange(newDay);
  kickWaitlist();
  const cust = await customerOf(b);
  if (cust) {
    fire(() => sendMessage(cust.phone, "booking_confirmed", {
      name: cust.name || "there", product: product.name, when: `${fmtDay(newDay)}, ${fmtMin(newStart)}`, code: b.code,
      link: `${baseUrl()}/b/${b.code}?t=${bookingToken(b.code)}`, waivers: `${baseUrl()}/w/${b.code}?t=${bookingToken(b.code)}`, directions: "Level 6, AMB Mall",
    }));
  }
}

// ---------------------------------------------------------------------------------------------
// Guest list (§6): the group leader edits names until check-in, without touching the schedule.
// ---------------------------------------------------------------------------------------------

export interface Guest { name: string; ageBand?: string }

export function guestList(b: BookingRow): Guest[] {
  try {
    const g = JSON.parse(b.guest_list) as Guest[];
    return Array.isArray(g) ? g : [];
  } catch {
    return [];
  }
}

export async function updateGuests(code: string, guests: Guest[], actor: string) {
  const b = await getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  if (!["hold", "confirmed"].includes(b.status)) throw new HttpError(409, b.status === "arrived" ? "The guest list is locked after check-in" : `Booking is ${b.status}`);
  const clean = guests.map((g) => ({ name: g.name.trim(), ...(g.ageBand ? { ageBand: g.ageBand } : {}) })).filter((g) => g.name);
  if (clean.length > b.party_size) throw new HttpError(400, `This booking is for ${b.party_size} guest(s) — the party size itself is changed at the desk`);
  await db().prepare("UPDATE bookings SET guest_list = ? WHERE id = ?").run(JSON.stringify(clean), b.id);
  await audit(actor, "guest_list_updated", b.code, { count: clean.length });
  emitChange(b.day);
  return clean;
}

// ---------------------------------------------------------------------------------------------
// Owner-approved refund exception (§8): the published policy is no refunds; the owner can make one.
// Online payments refund through the gateway; counter payments are recorded as a cash/UPI refund.
// ---------------------------------------------------------------------------------------------

export async function refundBooking(code: string, amountPaise: number, actor: string, approver: string, reason: string, opts: { cancel: boolean }) {
  const d = db();
  const b = await getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  const refundable = b.paid_paise - b.refunded_paise;
  if (amountPaise < 1 || amountPaise > refundable) throw new HttpError(400, `Refundable amount is at most ₹${(refundable / 100).toFixed(2)}`);
  const online = await d
    .prepare("SELECT id, provider, provider_payment_id, amount_paise FROM payments WHERE booking_id = ? AND status = 'captured' AND provider_payment_id IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get<{ id: number; provider: string; provider_payment_id: string; amount_paise: number }>(b.id);
  let refundId: string | null = null;
  if (online) {
    try {
      refundId = (await payments().refund(online.provider_payment_id, amountPaise)).refundId;
    } catch (e) {
      await audit(actor, "refund_failed", b.code, { error: String(e), amountPaise });
      throw new HttpError(502, "The payment gateway refused the refund — try again or refund at the counter");
    }
  }
  await tx(async () => {
    await d.prepare("INSERT INTO payments (booking_id, provider, provider_order_id, provider_payment_id, amount_paise, status, kind, raw, created_at) VALUES (?, ?, NULL, NULL, ?, 'refunded', 'refund', ?, ?)").run(
      b.id, online ? online.provider : b.payment_method ?? "counter", -amountPaise, JSON.stringify({ refund_id: refundId, reason, approver }), Date.now(),
    );
    await d.prepare("UPDATE bookings SET refunded_paise = refunded_paise + ? WHERE id = ?").run(amountPaise, b.id);
    if (opts.cancel && ["hold", "confirmed"].includes(b.status)) await d.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
    await audit(actor, "refund_owner_approved", b.code, { amountPaise, reason, approvedBy: approver, via: online ? "gateway" : "counter", refundId, cancelled: opts.cancel });
  });
  emitChange(b.day);
  if (opts.cancel) kickWaitlist();
  return { refundedPaise: amountPaise, via: online ? "gateway" : "counter", refundId };
}

// ---------------------------------------------------------------------------------------------
// Waivers
// ---------------------------------------------------------------------------------------------


export async function signWaivers(code: string, guests: { name: string; ageBand: string }[], ip: string, via: "online" | "desk") {
  const d = db();
  const b = await getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  if (!["hold", "confirmed", "arrived"].includes(b.status)) throw new HttpError(409, `Booking is ${b.status}`);
  const ins = d.prepare("INSERT INTO waivers (booking_id, customer_id, guest_name, age_band, signed_at, ip, signed_via) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const already = await tx(async () => {
    // Counted under the lock so two guests signing at once can't exceed the party size.
    const n = await waiverCount(b.id);
    if (n + guests.length > b.party_size) throw new HttpError(400, `Only ${b.party_size - n} more waiver(s) needed for this booking`);
    for (const g of guests) await ins.run(b.id, b.customer_id, g.name.trim(), g.ageBand, Date.now(), ip, via);
    return n;
  });
  await audit(via === "desk" ? "desk" : "customer", "waivers_signed", b.code, { count: guests.length });
  emitChange(b.day);
  return { signed: already + guests.length, party: b.party_size };
}

/**
 * Desk check-in for a group: the lead guest accepts the waiver once on behalf of everyone still unsigned,
 * so the desk doesn't type each guest's name. One record per seat keeps the waiver count = party size.
 */
export async function signGroupWaiver(code: string, ip: string) {
  const d = db();
  const b = await getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  if (!["hold", "confirmed", "arrived"].includes(b.status)) throw new HttpError(409, `Booking is ${b.status}`);
  const lead = (await customerOf(b))?.name?.trim() || "Lead guest";
  const ins = d.prepare("INSERT INTO waivers (booking_id, customer_id, guest_name, age_band, signed_at, ip, signed_via) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const added = await tx(async () => {
    const n = await waiverCount(b.id);
    const need = b.party_size - n;
    for (let i = 0; i < need; i++) {
      const k = n + i + 1;
      await ins.run(b.id, b.customer_id, k === 1 ? lead : `Guest ${k} (accepted by ${lead})`, "group", Date.now(), ip, "desk");
    }
    return need;
  });
  if (added > 0) {
    await audit("desk", "group_waiver_signed", b.code, { count: added, lead });
    emitChange(b.day);
  }
  return { signed: b.party_size, party: b.party_size };
}

// ---------------------------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------------------------

export async function activeMembership(phone: string, day: string) {
  return db()
    .prepare(
      `SELECT m.* FROM memberships m JOIN customers c ON c.id = m.customer_id
       WHERE c.phone = ? AND m.valid_till >= ? AND (m.visits_left IS NULL OR m.visits_left > 0) ORDER BY m.valid_till DESC LIMIT 1`,
    )
    .get<{ id: number; plan: string; valid_till: string; visits_left: number | null }>(phone, day);
}

async function validateMembership(membershipId: number | null, phone: string, day: string) {
  const m = await activeMembership(phone, day);
  if (!m || (membershipId && m.id !== membershipId)) throw new HttpError(400, "No active membership with visits left for this phone");
  const pending = (await db().prepare("SELECT COUNT(*) AS n FROM bookings WHERE membership_id = ? AND status IN ('hold','confirmed')").get<{ n: number }>(m.id))!.n;
  if (m.visits_left != null && pending >= m.visits_left) throw new HttpError(400, "All remaining membership visits are already booked");
  if (m.visits_left == null) {
    const sameDay = await db().prepare("SELECT 1 FROM bookings WHERE membership_id = ? AND day = ? AND status IN ('hold','confirmed','arrived','done')").get(m.id, day);
    if (sameDay) throw new HttpError(400, "Unlimited memberships include one visit per day");
  }
}

async function burnMembershipVisit(membershipId: number, bookingId: number) {
  const d = db();
  const used = await d.prepare("INSERT INTO membership_visits (membership_id, booking_id, used_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(membershipId, bookingId, Date.now());
  if (!used.changes) return;
  await d.prepare("UPDATE memberships SET visits_left = visits_left - 1 WHERE id = ? AND visits_left IS NOT NULL AND visits_left > 0").run(membershipId);
  const m = (await d
    .prepare("SELECT m.visits_left, m.valid_till, c.phone, c.name FROM memberships m JOIN customers c ON c.id = m.customer_id WHERE m.id = ?")
    .get<{ visits_left: number | null; valid_till: string; phone: string; name: string }>(membershipId))!;
  // Sent on every burned visit; the "2 visits left" case carries the renew nudge.
  fire(() => sendMessage(m.phone, "membership_update", membershipParams(m, m.visits_left != null && m.visits_left <= 2 ? "Running low — renew at the desk or on WhatsApp" : "Visit used — see you soon")));
}

/** One parameter shape for every membership_update send (WhatsApp templates have fixed slots). */
export function membershipParams(m: { name: string; visits_left: number | null; valid_till: string }, note: string) {
  return {
    name: m.name || "there",
    visits_left: m.visits_left == null ? "unlimited" : String(m.visits_left),
    valid_till: fmtDay(m.valid_till),
    note,
    link: `${baseUrl()}/me`,
  };
}

// ---------------------------------------------------------------------------------------------
// Waitlist (§9): any release auto-offers the slot in join order with a 10-min accept window.
// ---------------------------------------------------------------------------------------------

export async function processWaitlist() {
  const d = db();
  const t = Date.now();
  const waiting = await d.prepare("SELECT w.*, c.phone, c.name FROM waitlist w JOIN customers c ON c.id = w.customer_id WHERE w.state = 'waiting' ORDER BY w.created_at").all<{
    id: number; day: string; hour: number; product_id: string; party_size: number; token: string; phone: string; name: string;
  }>();
  const busy = new Set(
    (await d.prepare("SELECT day, hour FROM waitlist WHERE state = 'offered' AND offer_expires >= ?").all<{ day: string; hour: number }>(t)).map((r) => `${r.day}:${r.hour}`),
  );
  for (const w of waiting) {
    const k = `${w.day}:${w.hour}`;
    if (busy.has(k)) continue;
    try {
      const { result } = await quoteDay({ day: w.day, productId: w.product_id, party: w.party_size, channel: "online", windowStart: w.hour * 60, windowEnd: w.hour * 60 + 60, preferredMin: w.hour * 60, limit: 1 });
      const o = result.offers[0];
      if (!o) continue;
      // Claimed conditionally: two instances processing the waitlist at once must not double-offer.
      const claimed = await d
        .prepare("UPDATE waitlist SET state = 'offered', offer_start = ?, offer_expires = ? WHERE id = ? AND state = 'waiting'")
        .run(o.start, t + WAITLIST_OFFER_MS, w.id);
      if (!claimed.changes) continue;
      busy.add(k);
      await audit("system", "waitlist_offered", `waitlist:${w.id}`, { day: w.day, start: o.start });
      await sendMessage(w.phone, "waitlist_offer", {
        name: w.name || "there",
        when: `${fmtDay(w.day)}, ${fmtMin(o.start)}`,
        link: `${baseUrl()}/waitlist/${w.token}`,
      });
    } catch {
      /* day passed etc. */
    }
  }
}

export async function joinWaitlist(input: { day: string; hour: number; productId: string; party: number; phone: string; name: string }) {
  const cfg = await getDayConfig(input.day);
  if (input.hour * 60 < cfg.openMin || input.hour * 60 >= cfg.closeMin) throw new HttpError(400, "That hour is outside opening hours");
  const customerId = await upsertCustomer(input.phone, input.name);
  const token = crypto.randomBytes(12).toString("base64url");
  await db().prepare("INSERT INTO waitlist (day, hour, product_id, customer_id, party_size, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    input.day, input.hour, input.productId, customerId, input.party, token, Date.now(),
  );
  kickWaitlist();
  return { token };
}

// ---------------------------------------------------------------------------------------------
// Public view of a booking
// ---------------------------------------------------------------------------------------------

export async function bookingView(b: BookingRow, opts: { withQr: boolean }) {
  const d = db();
  const [p, roomList, legRows, inv, waivers, cust] = await Promise.all([
    getProduct(b.product_id).then((x) => x!),
    listRooms(),
    getLegs(b.id),
    d.prepare("SELECT number FROM invoices WHERE booking_id = ?").get<{ number: string }>(b.id),
    d.prepare("SELECT guest_name, age_band, signed_at FROM waivers WHERE booking_id = ? ORDER BY id").all<{ guest_name: string; age_band: string; signed_at: number }>(b.id),
    customerOf(b),
  ]);
  const rooms = new Map(roomList.map((r) => [r.id, r]));
  const legs = legRows.map((l) => ({ room: rooms.get(l.room_id)?.name ?? l.room_id, roomId: l.room_id, start: l.start_min, end: l.end_min }));
  const token = bookingToken(b.code);
  const canReschedule = b.status === "confirmed" && b.reschedule_count === 0 && istToEpoch(b.day, b.start_min) - Date.now() >= 24 * 60 * 60_000 && p.shape !== "party";
  return {
    code: b.code,
    token,
    status: b.status,
    product: { id: p.id, name: p.name, shape: p.shape },
    day: b.day,
    start: b.start_min,
    end: b.end_min,
    party: b.party_size,
    legs,
    pricePaise: b.price_paise,
    paidPaise: b.paid_paise,
    depositPaise: b.deposit_paise,
    holdExpires: b.hold_expires,
    invoice: inv?.number ?? null,
    waivers: waivers.map((w) => ({ name: w.guest_name, ageBand: w.age_band })),
    guests: guestList(b),
    canEditGuests: ["hold", "confirmed"].includes(b.status),
    refundedPaise: b.refunded_paise ?? 0,
    customerName: cust?.name ?? "",
    phoneMasked: cust ? cust.phone.slice(0, 3) + "•••••" + cust.phone.slice(-3) : "",
    canReschedule,
    rescheduleCount: b.reschedule_count,
    food: !!b.food,
    qr: opts.withQr ? await QRCode.toDataURL(`WON:${b.code}:${token}`, { margin: 1, width: 280 }) : null,
  };
}
