// Booking service: quote → hold → commit, plus every state change after it.
// Commits are serialized per day (an IMMEDIATE SQLite transaction; one writer process) and re-verify
// every leg against a freshly rebuilt ledger, so double-booking cannot happen (§10).

import crypto from "node:crypto";
import QRCode from "qrcode";
import { db } from "./db";
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
function genCode(): string {
  const d = db();
  for (;;) {
    let c = "WON-";
    const bytes = crypto.randomBytes(4);
    for (const b of bytes) c += CODE_ALPHABET[b % CODE_ALPHABET.length];
    if (!d.prepare("SELECT 1 FROM bookings WHERE code = ?").get(c)) return c;
  }
}

function fire(p: Promise<unknown>) {
  p.catch((e) => console.error("[won] background task failed", e));
}

/** Run the waitlist after the current transaction/request settles, never inside a commit. */
function kickWaitlist() {
  setTimeout(() => fire(processWaitlist()), 0);
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

export function quoteDay(input: QuoteInput) {
  const { day: today, min } = nowIST();
  if (input.day < today) throw new HttpError(400, "That date has passed");
  if (input.day > addDays(today, BOOKING_HORIZON_DAYS)) throw new HttpError(400, `Bookings open ${BOOKING_HORIZON_DAYS} days ahead`);
  sweep();
  const product = getProduct(input.productId, input.day);
  if (!product) throw new HttpError(404, "Unknown product");
  if (product.shape === "party" && input.channel === "online") throw new HttpError(400, "Parties are booked through our party desk — call or WhatsApp us");
  const ledger = buildLedger(input.day, { excludeBookingId: input.excludeBookingId });
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
  applyFlash(input.day, product, input.party, result.offers, ledger.cfg.peakHours);
  if (input.logRejection && !result.error && result.offers.length === 0) {
    const bad = falseSellouts(ledger, product, req);
    if (bad > 0) console.error(`[won] FALSE SELL-OUT: ${product.id} x${input.party} on ${input.day} — ${bad} start(s) had capacity but no assignment`);
    db().prepare("INSERT INTO quote_rejections (day, product_id, party, channel, false_sellout, at) VALUES (?, ?, ?, ?, ?, ?)").run(input.day, product.id, input.party, input.channel, bad > 0 ? 1 : 0, Date.now());
  }
  return { product, ledger, result };
}

/** §8.4 Upsell from real availability: could this same start seat them for 3 games or All 5? */
export function upsellsFor(day: string, product: Product, party: number, start: number, channel: "online" | "desk") {
  const out: { productId: string; name: string; start: number; extraPaise: number }[] = [];
  const tries = product.id === "c1" ? ["c3", "a5"] : product.id === "c3" ? ["a5", "combo"] : [];
  for (const pid of tries) {
    const p = getProduct(pid);
    if (!p || !p.active || party > p.maxParty || party < p.minParty) continue;
    const at = p.shape === "rotation" ? Math.floor(start / 60) * 60 : start;
    try {
      const { result } = quoteDay({ day, productId: pid, party, channel, exactStart: p.shape === "combo" ? null : at, windowStart: p.shape === "combo" ? start - 20 : null, windowEnd: p.shape === "combo" ? start + 21 : null, limit: 1 });
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
export function sweep(force = false) {
  const t = Date.now();
  if (!force && t - lastSweep < 2000) return;
  lastSweep = t;
  const d = db();
  const { day: today, min } = nowIST();
  const released: { day: string; start_min: number }[] = [];

  const expired = d.prepare("SELECT id, day, start_min FROM bookings WHERE status = 'hold' AND hold_expires < ?").all(t) as { id: number; day: string; start_min: number }[];
  if (expired.length) {
    const upd = d.prepare("UPDATE bookings SET status = 'expired' WHERE id = ? AND status = 'hold'");
    for (const e of expired) upd.run(e.id);
    released.push(...expired);
  }

  const noShows = d
    .prepare("SELECT id, code, day, start_min FROM bookings WHERE status = 'confirmed' AND (day < ? OR (day = ? AND start_min + ? < ?))")
    .all(today, today, NO_SHOW_GRACE_MIN, min) as { id: number; code: string; day: string; start_min: number }[];
  for (const n of noShows) {
    d.prepare("UPDATE bookings SET status = 'no_show' WHERE id = ?").run(n.id);
    audit("system", "auto_no_show", n.code, { graceMin: NO_SHOW_GRACE_MIN });
    released.push(n);
  }
  d.prepare("UPDATE bookings SET status = 'done' WHERE status = 'arrived' AND (day < ? OR (day = ? AND end_min < ?))").run(today, today, min);
  d.prepare("UPDATE waitlist SET state = 'expired' WHERE state = 'offered' AND offer_expires < ?").run(t);
  d.prepare("UPDATE waitlist SET state = 'expired' WHERE state = 'waiting' AND (day < ? OR (day = ? AND hour * 60 + 60 <= ?))").run(today, today, min);

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

function alternatives(day: string, productId: string, party: number, around: number, channel: "online" | "desk") {
  try {
    return quoteDay({ day, productId, party, channel, preferredMin: around, limit: 3 }).result.offers.map((o) => ({ start: o.start, end: o.end }));
  } catch {
    return [];
  }
}

export async function createHold(input: HoldInput): Promise<HoldResult> {
  const d = db();
  if (input.idemKey) {
    const existing = d.prepare("SELECT code FROM bookings WHERE idem_key = ?").get(input.idemKey) as { code: string } | undefined;
    if (existing) return holdResultFor(existing.code);
  }
  assertWritable();
  const channel = input.source === "online" ? "online" : "desk";
  const product = getProduct(input.productId, input.day);
  if (!product) throw new HttpError(404, "Unknown product");

  if (product.shape === "party") {
    const lead = istToEpoch(input.day, input.start) - Date.now();
    if (lead < PARTY_LEAD_MS && !input.overridePartyLead) throw new HttpError(400, "Parties need at least 48 h notice (manager override available)");
  }
  if (input.payment === "membership") {
    validateMembership(input.membershipId ?? null, input.phone, input.day);
    checkMemberHorizon(input.day, input.start);
  }

  const customerId = upsertCustomer(input.phone, input.name);
  const isOnlinePay = input.payment === "online";
  const ttl = product.shape === "party" ? PARTY_HOLD_TTL_MS : HOLD_TTL_MS;

  const commit = d.transaction((): { code: string; offer: Offer; due: number } => {
    // Re-quote at the exact start under the lock — never trust client-supplied legs.
    const { result } = quoteDay({ day: input.day, productId: input.productId, party: input.party, chosenRooms: input.chosenRooms, channel, exactStart: input.start, limit: 1 });
    if (result.error) throw new HttpError(400, result.error);
    const offer = result.offers[0];
    if (!offer) {
      throw new HttpError(409, "Sorry — that slot was just taken.", { alternatives: alternatives(input.day, input.productId, input.party, input.start, channel) });
    }
    const code = genCode();
    const price = input.payment === "membership" || input.payment === "comp" ? 0 : offer.pricePaise;
    const deposit = product.shape === "party" ? Math.round(price * 0.25) : 0;
    const due = product.shape === "party" ? deposit : price;
    const status = isOnlinePay && due > 0 ? "hold" : "confirmed";
    const guests = (input.guestNames ?? []).filter(Boolean).map((name) => ({ name }));
    const info = d
      .prepare(
        `INSERT INTO bookings (code, product_id, customer_id, day, start_min, end_min, party_size, guest_list, status, source, price_paise, deposit_paise, paid_paise, payment_method, idem_key, hold_expires, food, notes, membership_id, created_at)
         VALUES (@code, @product_id, @customer_id, @day, @start, @end, @party, @guests, @status, @source, @price, @deposit, @paid, @method, @idem, @expires, @food, @notes, @membership, @created)`,
      )
      .run({
        code, product_id: product.id, customer_id: customerId, day: input.day, start: offer.start, end: offer.end, party: input.party,
        guests: JSON.stringify(guests), status, source: input.source, price, deposit,
        paid: status === "confirmed" && !isOnlinePay ? due : 0,
        method: input.payment, idem: input.idemKey ?? null, expires: status === "hold" ? Date.now() + ttl : null,
        food: input.food ? 1 : 0, notes: input.notes ?? "", membership: input.payment === "membership" ? input.membershipId ?? null : null, created: Date.now(),
      });
    const id = Number(info.lastInsertRowid);
    insertLegs(id, input.day, offer.legs, offer.blocks ?? []);
    audit(input.actor, status === "hold" ? "hold_created" : "booking_created", code, { product: product.id, party: input.party, start: offer.start, payment: input.payment, source: input.source });
    return { code, offer, due };
  });

  const { code, due } = commit.immediate();
  const booking = getBookingByCode(code)!;
  emitChange(input.day);

  if (booking.status === "hold") {
    try {
      const pp = payments();
      const { orderId } = await pp.createOrder(due, code);
      d.prepare("INSERT INTO payments (booking_id, provider, provider_order_id, amount_paise, status, kind, created_at) VALUES (?, ?, ?, ?, 'created', ?, ?)").run(
        booking.id, pp.name, orderId, due, product.shape === "party" ? "deposit" : "booking", Date.now(),
      );
    } catch (e) {
      d.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
      emitChange(input.day);
      console.error(e);
      throw new HttpError(502, "Payment gateway unavailable — please try again");
    }
  } else {
    afterConfirm(booking.id);
  }
  return holdResultFor(code);
}

function insertLegs(bookingId: number, day: string, legs: Leg[], blocks: Block[]) {
  const d = db();
  const ins = d.prepare("INSERT INTO booking_legs (booking_id, leg_no, room_id, day, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?)");
  legs.forEach((l, i) => ins.run(bookingId, i, l.roomId, day, l.start, l.end));
  const insB = d.prepare("INSERT INTO calendar_blocks (room_id, day, start_min, end_min, reason, booking_id) VALUES (?, ?, ?, ?, ?, ?)");
  for (const b of blocks) insB.run(b.roomId, day, b.start, b.end, b.reason, bookingId);
}

export function holdResultFor(code: string): HoldResult {
  const b = getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  const p = db().prepare("SELECT * FROM payments WHERE booking_id = ? ORDER BY id DESC LIMIT 1").get(b.id) as
    | { provider: string; provider_order_id: string; amount_paise: number; status: string }
    | undefined;
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
  const pay = d.prepare("SELECT * FROM payments WHERE provider_order_id = ?").get(orderId) as
    | { id: number; booking_id: number; status: string; amount_paise: number; provider_payment_id: string | null; kind: string }
    | undefined;
  if (!pay) return { ok: false, reason: "unknown order" };
  if (pay.status === "captured" || pay.status === "refunded") return { ok: true, deduped: true };
  if (d.prepare("SELECT 1 FROM payments WHERE provider_payment_id = ?").get(paymentId)) return { ok: true, deduped: true };

  const amount = amountPaise ?? pay.amount_paise;
  d.prepare("UPDATE payments SET status = 'captured', provider_payment_id = ?, raw = ? WHERE id = ?").run(paymentId, JSON.stringify(raw ?? {}), pay.id);

  const outcome = d
    .transaction((): "confirmed" | "already" | "refund" => {
      const b = d.prepare("SELECT * FROM bookings WHERE id = ?").get(pay.booking_id) as BookingRow;
      if (["confirmed", "arrived", "done"].includes(b.status)) {
        d.prepare("UPDATE bookings SET paid_paise = paid_paise + ? WHERE id = ?").run(amount, b.id);
        return "already";
      }
      const live = b.status === "hold" && (b.hold_expires ?? 0) >= Date.now();
      if (!live) {
        // Late payment (slow UPI): retry the commit against the current ledger.
        const product = getProduct(b.product_id)!;
        const ledger = buildLedger(b.day, { excludeBookingId: b.id });
        const legs = getLegs(b.id).map((l) => ({ roomId: l.room_id, start: l.start_min, end: l.end_min }));
        const blocks = (d.prepare("SELECT room_id, start_min, end_min, reason FROM calendar_blocks WHERE booking_id = ?").all(b.id) as { room_id: string; start_min: number; end_min: number; reason: string }[]).map(
          (x) => ({ roomId: x.room_id, start: x.start_min, end: x.end_min, reason: x.reason }),
        );
        if (!stillFits(ledger, product, b.party_size, legs, blocks)) {
          d.prepare("UPDATE bookings SET status = 'cancelled', notes = notes || ' [auto-refunded: seats gone after late payment]' WHERE id = ?").run(b.id);
          return "refund";
        }
      }
      d.prepare("UPDATE bookings SET status = 'confirmed', hold_expires = NULL, paid_paise = paid_paise + ? WHERE id = ?").run(amount, b.id);
      return "confirmed";
    })
    .immediate();

  const b = d.prepare("SELECT * FROM bookings WHERE id = ?").get(pay.booking_id) as BookingRow;
  if (outcome === "refund") {
    try {
      const { refundId } = await payments().refund(paymentId, amount);
      d.prepare("UPDATE payments SET status = 'refunded', raw = json_set(COALESCE(raw,'{}'), '$.refund_id', ?) WHERE id = ?").run(refundId, pay.id);
    } catch (e) {
      audit("system", "refund_failed", b.code, { error: String(e) });
    }
    audit("system", "late_payment_refunded", b.code, { paymentId, amount });
    const cust = customerOf(b);
    if (cust) {
      const alts = alternatives(b.day, b.product_id, b.party_size, b.start_min, "online");
      fire(sendMessage(cust.phone, "booking_apology", {
        name: cust.name || "there",
        code: b.code,
        alternatives: alts.map((a) => fmtMin(a.start)).join(", ") || "none today",
        link: `${baseUrl()}/`,
      }));
    }
    emitChange(b.day);
    return { ok: true, refunded: true, code: b.code };
  }
  if (outcome === "confirmed") afterConfirm(b.id);
  return { ok: true, code: b.code };
}

export function handlePaymentFailed(orderId: string) {
  const d = db();
  const pay = d.prepare("SELECT booking_id FROM payments WHERE provider_order_id = ?").get(orderId) as { booking_id: number } | undefined;
  if (!pay) return;
  d.prepare("UPDATE payments SET status = 'failed' WHERE provider_order_id = ? AND status = 'created'").run(orderId);
  const b = d.prepare("SELECT code, day, status FROM bookings WHERE id = ?").get(pay.booking_id) as { code: string; day: string; status: string };
  if (b.status === "hold") {
    d.prepare("UPDATE bookings SET status = 'expired' WHERE id = ?").run(pay.booking_id);
    audit("system", "hold_released_payment_failed", b.code);
    emitChange(b.day);
    kickWaitlist();
  }
}

function customerOf(b: BookingRow) {
  return b.customer_id ? (db().prepare("SELECT * FROM customers WHERE id = ?").get(b.customer_id) as { id: number; phone: string; name: string }) : null;
}

function afterConfirm(bookingId: number) {
  const d = db();
  const b = d.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId) as BookingRow;
  ensureInvoice(b);
  const p = getProduct(b.product_id)!;
  const cust = customerOf(b);
  audit("system", "booking_confirmed", b.code, { paid: b.paid_paise });
  emitChange(b.day);
  if (cust) {
    fire(sendMessage(cust.phone, "booking_confirmed", {
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

function ensureInvoice(b: BookingRow) {
  const d = db();
  if (d.prepare("SELECT 1 FROM invoices WHERE booking_id = ?").get(b.id)) return;
  if (b.price_paise <= 0) return;
  const fy = financialYear(Date.now());
  d.transaction(() => {
    const seq = ((d.prepare("SELECT MAX(seq) AS s FROM invoices WHERE fy = ?").get(fy) as { s: number | null }).s ?? 0) + 1;
    const taxable = Math.round(b.price_paise / 1.18);
    const gst = b.price_paise - taxable;
    const detail = { total: b.price_paise, taxable, cgst: Math.floor(gst / 2), sgst: gst - Math.floor(gst / 2), rate: 18, inclusive: true };
    d.prepare("INSERT INTO invoices (booking_id, number, fy, seq, gst_detail, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      b.id, `WON/${fy}/${String(seq).padStart(5, "0")}`, fy, seq, JSON.stringify(detail), Date.now(),
    );
  }).immediate();
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

export function waiverCount(bookingId: number): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM waivers WHERE booking_id = ?").get(bookingId) as { n: number }).n;
}

export function checkIn(scan: string, actor: string, opts: { shrinkTo?: number | null } = {}) {
  sweep(true);
  const d = db();
  const b = getBookingByCode(parseScan(scan));
  if (!b) throw new HttpError(404, "Booking not found");
  const { day: today } = nowIST();
  if (b.status === "arrived") throw new HttpError(409, "Already checked in");
  if (b.day !== today) throw new HttpError(409, `This booking is for ${fmtDay(b.day)}`);
  if (b.status === "no_show") {
    // Late arrival after the auto no-show: allowed only if their seats were not resold.
    const product = getProduct(b.product_id)!;
    const ledger = buildLedger(b.day, { excludeBookingId: b.id });
    const { min } = nowIST();
    const legs = getLegs(b.id).map((l) => ({ roomId: l.room_id, start: l.start_min, end: l.end_min })).filter((l) => l.end > min);
    if (legs.length === 0 || !stillFits(ledger, product, b.party_size, legs)) throw new HttpError(409, "Marked no-show and the slot has been resold — offer a new slot via walk-in");
  } else if (b.status !== "confirmed") throw new HttpError(409, `Booking is ${b.status.replace("_", "-")}`);
  const signed = waiverCount(b.id);
  let party = b.party_size;
  if (signed < party) {
    if (!opts.shrinkTo) throw new HttpError(409, "Waivers missing", { needWaivers: true, signed, party });
    if (opts.shrinkTo < 1 || opts.shrinkTo > signed) throw new HttpError(400, `Can check in at most ${signed} guest(s) with signed waivers`);
    party = opts.shrinkTo;
  }
  d.transaction(() => {
    if (party !== b.party_size) {
      d.prepare("UPDATE bookings SET party_size = ? WHERE id = ?").run(party, b.id);
      audit(actor, "party_shrunk_at_checkin", b.code, { from: b.party_size, to: party, reason: "unsigned waivers" });
    }
    d.prepare("UPDATE bookings SET status = 'arrived', arrived_at = ? WHERE id = ?").run(Date.now(), b.id);
    if (b.membership_id) burnMembershipVisit(b.membership_id, b.id);
    audit(actor, "checked_in", b.code, { party });
  }).immediate();
  emitChange(b.day);
  if (party !== b.party_size) kickWaitlist();
  return { code: b.code, party };
}

export function markNoShow(code: string, actor: string, reason: string) {
  const b = getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  if (b.status !== "confirmed") throw new HttpError(409, `Booking is ${b.status}`);
  db().prepare("UPDATE bookings SET status = 'no_show' WHERE id = ?").run(b.id);
  audit(actor, "manual_no_show", b.code, { reason });
  emitChange(b.day);
  kickWaitlist();
}

export function cancelBooking(code: string, actor: string, reason: string) {
  const b = getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  if (!["hold", "confirmed"].includes(b.status)) throw new HttpError(409, `Booking is ${b.status}`);
  db().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
  audit(actor, "cancelled_override", b.code, { reason, paid: b.paid_paise, note: "No refund per policy unless owner-approved" });
  emitChange(b.day);
  kickWaitlist();
}

export function reschedule(code: string, newDay: string, newStart: number, actor: string, opts: { override: boolean; reason?: string }) {
  const d = db();
  const b = getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  if (b.status !== "confirmed") throw new HttpError(409, `Only confirmed bookings can be moved (this one is ${b.status})`);
  assertWritable();
  if (!opts.override) {
    if (b.reschedule_count >= 1) throw new HttpError(403, "The one free reschedule has been used — please contact the desk");
    if (istToEpoch(b.day, b.start_min) - Date.now() < 24 * 60 * 60_000) throw new HttpError(403, "Free reschedules close 24 h before your slot");
  }
  const product = getProduct(b.product_id)!;
  const oldDay = b.day;
  d.transaction(() => {
    const { result } = quoteDay({ day: newDay, productId: b.product_id, party: b.party_size, channel: "desk", exactStart: newStart, excludeBookingId: b.id, limit: 1 });
    const offer = result.offers[0];
    if (!offer) throw new HttpError(409, "That slot isn't available");
    if (offer.pricePaise > b.price_paise && !opts.override && b.price_paise > 0) throw new HttpError(409, "Reschedules are limited to equal-value slots");
    d.prepare("DELETE FROM booking_legs WHERE booking_id = ?").run(b.id);
    d.prepare("DELETE FROM calendar_blocks WHERE booking_id = ?").run(b.id);
    insertLegs(b.id, newDay, offer.legs, offer.blocks ?? []);
    d.prepare("UPDATE bookings SET day = ?, start_min = ?, end_min = ?, reschedule_count = reschedule_count + 1 WHERE id = ?").run(newDay, offer.start, offer.end, b.id);
    audit(actor, opts.override ? "reschedule_override" : "rescheduled", b.code, { from: { day: oldDay, start: b.start_min }, to: { day: newDay, start: offer.start }, reason: opts.reason ?? null, product: product.id });
  }).immediate();
  emitChange(oldDay);
  emitChange(newDay);
  kickWaitlist();
  const cust = customerOf(b);
  if (cust) {
    fire(sendMessage(cust.phone, "booking_confirmed", {
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

export function updateGuests(code: string, guests: Guest[], actor: string) {
  const b = getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  if (!["hold", "confirmed"].includes(b.status)) throw new HttpError(409, b.status === "arrived" ? "The guest list is locked after check-in" : `Booking is ${b.status}`);
  const clean = guests.map((g) => ({ name: g.name.trim(), ...(g.ageBand ? { ageBand: g.ageBand } : {}) })).filter((g) => g.name);
  if (clean.length > b.party_size) throw new HttpError(400, `This booking is for ${b.party_size} guest(s) — the party size itself is changed at the desk`);
  db().prepare("UPDATE bookings SET guest_list = ? WHERE id = ?").run(JSON.stringify(clean), b.id);
  audit(actor, "guest_list_updated", b.code, { count: clean.length });
  emitChange(b.day);
  return clean;
}

// ---------------------------------------------------------------------------------------------
// Owner-approved refund exception (§8): the published policy is no refunds; the owner can make one.
// Online payments refund through the gateway; counter payments are recorded as a cash/UPI refund.
// ---------------------------------------------------------------------------------------------

export async function refundBooking(code: string, amountPaise: number, actor: string, approver: string, reason: string, opts: { cancel: boolean }) {
  const d = db();
  const b = getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  const refundable = b.paid_paise - b.refunded_paise;
  if (amountPaise < 1 || amountPaise > refundable) throw new HttpError(400, `Refundable amount is at most ₹${(refundable / 100).toFixed(2)}`);
  const online = d
    .prepare("SELECT id, provider, provider_payment_id, amount_paise FROM payments WHERE booking_id = ? AND status = 'captured' AND provider_payment_id IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get(b.id) as { id: number; provider: string; provider_payment_id: string; amount_paise: number } | undefined;
  let refundId: string | null = null;
  if (online) {
    try {
      refundId = (await payments().refund(online.provider_payment_id, amountPaise)).refundId;
    } catch (e) {
      audit(actor, "refund_failed", b.code, { error: String(e), amountPaise });
      throw new HttpError(502, "The payment gateway refused the refund — try again or refund at the counter");
    }
  }
  d.transaction(() => {
    d.prepare("INSERT INTO payments (booking_id, provider, provider_order_id, provider_payment_id, amount_paise, status, kind, raw, created_at) VALUES (?, ?, NULL, NULL, ?, 'refunded', 'refund', ?, ?)").run(
      b.id, online ? online.provider : b.payment_method ?? "counter", -amountPaise, JSON.stringify({ refund_id: refundId, reason, approver }), Date.now(),
    );
    d.prepare("UPDATE bookings SET refunded_paise = refunded_paise + ? WHERE id = ?").run(amountPaise, b.id);
    if (opts.cancel && ["hold", "confirmed"].includes(b.status)) d.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
    audit(actor, "refund_owner_approved", b.code, { amountPaise, reason, approvedBy: approver, via: online ? "gateway" : "counter", refundId, cancelled: opts.cancel });
  }).immediate();
  emitChange(b.day);
  if (opts.cancel) kickWaitlist();
  return { refundedPaise: amountPaise, via: online ? "gateway" : "counter", refundId };
}

// ---------------------------------------------------------------------------------------------
// Waivers
// ---------------------------------------------------------------------------------------------


export function signWaivers(code: string, guests: { name: string; ageBand: string }[], ip: string, via: "online" | "desk") {
  const d = db();
  const b = getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  if (!["hold", "confirmed", "arrived"].includes(b.status)) throw new HttpError(409, `Booking is ${b.status}`);
  const already = waiverCount(b.id);
  if (already + guests.length > b.party_size) throw new HttpError(400, `Only ${b.party_size - already} more waiver(s) needed for this booking`);
  const ins = d.prepare("INSERT INTO waivers (booking_id, customer_id, guest_name, age_band, signed_at, ip, signed_via) VALUES (?, ?, ?, ?, ?, ?, ?)");
  d.transaction(() => {
    for (const g of guests) ins.run(b.id, b.customer_id, g.name.trim(), g.ageBand, Date.now(), ip, via);
  })();
  audit(via === "desk" ? "desk" : "customer", "waivers_signed", b.code, { count: guests.length });
  emitChange(b.day);
  return { signed: already + guests.length, party: b.party_size };
}

// ---------------------------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------------------------

export function activeMembership(phone: string, day: string) {
  return db()
    .prepare(
      `SELECT m.* FROM memberships m JOIN customers c ON c.id = m.customer_id
       WHERE c.phone = ? AND m.valid_till >= ? AND (m.visits_left IS NULL OR m.visits_left > 0) ORDER BY m.valid_till DESC LIMIT 1`,
    )
    .get(phone, day) as { id: number; plan: string; valid_till: string; visits_left: number | null } | undefined;
}

function validateMembership(membershipId: number | null, phone: string, day: string) {
  const m = activeMembership(phone, day);
  if (!m || (membershipId && m.id !== membershipId)) throw new HttpError(400, "No active membership with visits left for this phone");
  const pending = (db().prepare("SELECT COUNT(*) AS n FROM bookings WHERE membership_id = ? AND status IN ('hold','confirmed')").get(m.id) as { n: number }).n;
  if (m.visits_left != null && pending >= m.visits_left) throw new HttpError(400, "All remaining membership visits are already booked");
  if (m.visits_left == null) {
    const sameDay = db().prepare("SELECT 1 FROM bookings WHERE membership_id = ? AND day = ? AND status IN ('hold','confirmed','arrived','done')").get(m.id, day);
    if (sameDay) throw new HttpError(400, "Unlimited memberships include one visit per day");
  }
}

function burnMembershipVisit(membershipId: number, bookingId: number) {
  const d = db();
  d.prepare("INSERT OR IGNORE INTO membership_visits (membership_id, booking_id, used_at) VALUES (?, ?, ?)").run(membershipId, bookingId, Date.now());
  d.prepare("UPDATE memberships SET visits_left = visits_left - 1 WHERE id = ? AND visits_left IS NOT NULL AND visits_left > 0").run(membershipId);
  const m = d.prepare("SELECT m.visits_left, m.valid_till, c.phone, c.name FROM memberships m JOIN customers c ON c.id = m.customer_id WHERE m.id = ?").get(membershipId) as { visits_left: number | null; valid_till: string; phone: string; name: string };
  // Sent on every burned visit; the "2 visits left" case carries the renew nudge.
  fire(sendMessage(m.phone, "membership_update", membershipParams(m, m.visits_left != null && m.visits_left <= 2 ? "Running low — renew at the desk or on WhatsApp" : "Visit used — see you soon")));
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
  const waiting = d.prepare("SELECT w.*, c.phone, c.name FROM waitlist w JOIN customers c ON c.id = w.customer_id WHERE w.state = 'waiting' ORDER BY w.created_at").all() as {
    id: number; day: string; hour: number; product_id: string; party_size: number; token: string; phone: string; name: string;
  }[];
  const busy = new Set(
    (d.prepare("SELECT day, hour FROM waitlist WHERE state = 'offered' AND offer_expires >= ?").all(t) as { day: string; hour: number }[]).map((r) => `${r.day}:${r.hour}`),
  );
  for (const w of waiting) {
    const k = `${w.day}:${w.hour}`;
    if (busy.has(k)) continue;
    try {
      const { result } = quoteDay({ day: w.day, productId: w.product_id, party: w.party_size, channel: "online", windowStart: w.hour * 60, windowEnd: w.hour * 60 + 60, preferredMin: w.hour * 60, limit: 1 });
      const o = result.offers[0];
      if (!o) continue;
      d.prepare("UPDATE waitlist SET state = 'offered', offer_start = ?, offer_expires = ? WHERE id = ?").run(o.start, t + WAITLIST_OFFER_MS, w.id);
      busy.add(k);
      audit("system", "waitlist_offered", `waitlist:${w.id}`, { day: w.day, start: o.start });
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

export function joinWaitlist(input: { day: string; hour: number; productId: string; party: number; phone: string; name: string }) {
  const cfg = getDayConfig(input.day);
  if (input.hour * 60 < cfg.openMin || input.hour * 60 >= cfg.closeMin) throw new HttpError(400, "That hour is outside opening hours");
  const customerId = upsertCustomer(input.phone, input.name);
  const token = crypto.randomBytes(12).toString("base64url");
  db().prepare("INSERT INTO waitlist (day, hour, product_id, customer_id, party_size, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
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
  const p = getProduct(b.product_id)!;
  const rooms = new Map(listRooms().map((r) => [r.id, r]));
  const legs = getLegs(b.id).map((l) => ({ room: rooms.get(l.room_id)?.name ?? l.room_id, roomId: l.room_id, start: l.start_min, end: l.end_min }));
  const inv = d.prepare("SELECT number FROM invoices WHERE booking_id = ?").get(b.id) as { number: string } | undefined;
  const waivers = d.prepare("SELECT guest_name, age_band, signed_at FROM waivers WHERE booking_id = ? ORDER BY id").all(b.id) as { guest_name: string; age_band: string; signed_at: number }[];
  const cust = customerOf(b);
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
