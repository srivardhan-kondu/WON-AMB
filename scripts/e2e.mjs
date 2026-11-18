// End-to-end test against a running server.
// Usage: DATABASE_URL=<throwaway db> npm start   then   npm run test:e2e -- http://localhost:3000 <same DATABASE_URL>
// Use a throwaway database — the test creates bookings and changes prices/day config.
import pg from "pg";

pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
const BASE = process.argv[2];
const pool = new pg.Pool({ connectionString: process.argv[3] || process.env.DATABASE_URL, max: 2 });
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const db = {
  prepare: (sql) => ({
    get: async (...a) => (await pool.query(toPg(sql), a)).rows[0],
    all: async (...a) => (await pool.query(toPg(sql), a)).rows,
    run: async (...a) => { await pool.query(toPg(sql), a); },
  }),
};
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };

async function call(path, { method, body, cookie, idem } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (idem) headers["idempotency-key"] = idem;
  const r = await fetch(BASE + path, { method: method ?? (body !== undefined ? "POST" : "GET"), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j, setCookie: r.headers.get("set-cookie") };
}
const ist = new Date(Date.now() + 330 * 60000);
const today = ist.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const tomorrow = addDays(today, 1);
// find next Tuesday-ish weekday (off-peak) for clean capacity tests
let wk = addDays(today, 2);
while ([0, 5, 6].includes(new Date(wk + "T00:00:00Z").getUTCDay())) wk = addDays(wk, 1);

console.log("1. Catalogue & quote");
const prods = await call("/api/products");
ok(prods.status === 200 && prods.j.products.length >= 5, `products listed (${prods.j.products?.length}), payment=${prods.j.payment?.provider}`);
const q = await call("/api/quote", { body: { product: "c3", party: 4, date: tomorrow, preferredMin: 18 * 60 } });
ok(q.status === 200 && q.j.offers.length > 0 && q.j.offers.length <= 5, `c3 quote returns ${q.j.offers?.length} offers`);
ok(q.j.offers[0].start === 18 * 60, "preferred time is offered first");
const legs = q.j.offers[0].legs;
ok(new Set(legs.map((l) => l.roomId)).size === 3 && legs[1].start === legs[0].end && legs[2].start === legs[1].end, "3 distinct rooms, back-to-back");
const party = await call("/api/quote", { body: { product: "party_games", party: 12, date: tomorrow } });
ok(party.status === 400, "parties not bookable online");

console.log("2. Hold → pay (mock webhook) → confirmed");
const idem = "test-" + Date.now();
const hold = await call("/api/holds", { body: { product: "c3", party: 4, date: tomorrow, start: 18 * 60, name: "Asha Rao", phone: "9876543210" }, idem });
ok(hold.status === 201 && hold.j.status === "hold" && hold.j.order?.orderId, `hold created ${hold.j.code} due ₹${hold.j.amountDuePaise / 100}`);
const again = await call("/api/holds", { body: { product: "c3", party: 4, date: tomorrow, start: 18 * 60, name: "Asha Rao", phone: "9876543210" }, idem });
ok(again.j.code === hold.j.code, "idempotent: same key → same booking");
const view0 = await call(`/api/bookings/${hold.j.code}?t=${hold.j.token}`);
ok(view0.j.status === "hold", "booking viewable by token");
const bad = await call(`/api/bookings/${hold.j.code}?t=wrongtoken000000`);
ok(bad.status === 403, "wrong token rejected");
const byPhone = await call(`/api/bookings/${hold.j.code}?phone=98765%2043210`);
ok(byPhone.status === 200, "code + phone lookup works");
const pay = await call("/api/payments/mock", { body: { orderId: hold.j.order.orderId, outcome: "success" } });
ok(pay.j.ok && pay.j.code === hold.j.code, "mock capture confirmed");
const pay2 = await call("/api/payments/mock", { body: { orderId: hold.j.order.orderId, outcome: "success" } });
ok(pay2.j.deduped, "replayed webhook deduped");
const view = await call(`/api/bookings/${hold.j.code}?t=${hold.j.token}`);
ok(view.j.status === "confirmed" && view.j.paidPaise === 399600 && view.j.invoice?.startsWith("WON/"), `confirmed, paid ₹${view.j.paidPaise / 100}, invoice ${view.j.invoice}`);
ok(view.j.qr?.startsWith("data:image/png"), "QR generated");
const msgs = (await db.prepare("SELECT template FROM messages WHERE template='booking_confirmed'").all());
ok(msgs.length >= 1, "WhatsApp confirmation logged to outbox");

console.log("3. Waivers");
const w1 = await call(`/api/waivers/${hold.j.code}`, { body: { t: hold.j.token, guests: [{ name: "Asha Rao", ageBand: "18+", accept: true }, { name: "Ravi Rao", ageBand: "10–17", accept: true }] } });
ok(w1.status === 200 && w1.j.signed === 2, "2 waivers signed");
const w2 = await call(`/api/waivers/${hold.j.code}`, { body: { t: hold.j.token, guests: [1, 2, 3].map((i) => ({ name: "Extra " + i, ageBand: "18+", accept: true })) } });
ok(w2.status === 400, "cannot sign more waivers than party size");

console.log("4. Capacity & race: 6 parallel holds for a room that fits 1 more group");
// Fill one 20-min splatter session: capacity 12. Book 10, then race 6 holds of 2 → exactly 1 should win.
const splatStart = 11 * 60 + 75; // 12:15
const fill = await call("/api/holds", { body: { product: "splat", party: 10, date: wk, start: splatStart, name: "Fill", phone: "9000000001" } });
ok(fill.status === 201, "filled 10/12 of splatter session");
const racers = await Promise.all(
  [1, 2, 3, 4, 5, 6].map((i) => call("/api/holds", { body: { product: "splat", party: 2, date: wk, start: splatStart, name: "Racer " + i, phone: "900000001" + i } })),
);
const winners = racers.filter((r) => r.status === 201).length;
const losers = racers.filter((r) => r.status === 409);
ok(winners === 1 && losers.length === 5, `exactly one racer won (${winners} won, ${losers.length} got 409)`);
ok(losers[0]?.j.alternatives?.length > 0, `losers get alternatives (${losers[0]?.j.alternatives?.map((a) => a.start).join(",")})`);
const occ = (await db.prepare(`SELECT SUM(party_size) AS n FROM bookings WHERE day=? AND start_min=? AND product_id='splat' AND status IN ('hold','confirmed')`).get(wk, splatStart));
ok(occ.n === 12, `session holds exactly 12 (got ${occ.n})`);

console.log("5. Hold expiry & late payment");
const h2 = await call("/api/holds", { body: { product: "c1", party: 2, date: wk, start: 14 * 60, name: "Late Payer", phone: "9111111111" } });
(await db.prepare("UPDATE bookings SET hold_expires = ? WHERE code = ?").run(Date.now() - 1000, h2.j.code));
const late = await call("/api/payments/mock", { body: { orderId: h2.j.order.orderId, outcome: "success" } });
const lv = await call(`/api/bookings/${h2.j.code}?t=${h2.j.token}`);
ok(late.j.ok && lv.j.status === "confirmed", "late payment re-commits when seats are still free");
// Late payment where seats are gone → auto refund
const h3 = await call("/api/holds", { body: { product: "splat", party: 12, date: wk, start: 11 * 60, name: "Slow UPI", phone: "9222222222" } });
(await db.prepare("UPDATE bookings SET hold_expires = ? WHERE code = ?").run(Date.now() - 1000, h3.j.code));
const thief = await call("/api/holds", { body: { product: "splat", party: 12, date: wk, start: 11 * 60, name: "Faster", phone: "9333333333" } });
ok(thief.status === 201, "expired hold's seats resold");
const late2 = await call("/api/payments/mock", { body: { orderId: h3.j.order.orderId, outcome: "success" } });
ok(late2.j.refunded === true, "late payment with seats gone → auto refund");
ok((await db.prepare("SELECT status FROM payments WHERE provider_order_id=?").get(h3.j.order.orderId)).status === "refunded", "payment row marked refunded");
ok((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE template='booking_apology'").get()).n === 1, "apology + alternatives message sent");

console.log("6. Rotation Hours don't mix with 20-min grid");
const a5 = await call("/api/holds", { body: { product: "a5", party: 3, date: wk, start: 19 * 60, name: "All Five", phone: "9444444444" } });
ok(a5.status === 201, "All-5 booked at 19:00 (hour converts to Rotation Hour)");
const c3at19 = await call("/api/quote", { body: { product: "c3", party: 2, date: wk, preferredMin: 19 * 60 } });
ok(!c3at19.j.offers.some((o) => o.legs.some((l) => l.start >= 19 * 60 && l.start < 20 * 60)), "no 20-min legs offered inside the 19:00 Rotation Hour");
const c1q = await call("/api/quote", { body: { product: "c1", party: 2, date: wk, preferredMin: 13 * 60 } });
ok(c1q.j.upsells?.length > 0, `Choice-of-1 quote carries upsells: ${c1q.j.upsells?.map((u) => u.productId + " +₹" + u.extraPaise / 100).join(", ")}`);

console.log("7. Staff auth & roles");
const noauth = await call("/api/desk/today");
ok(noauth.status === 401, "desk API needs login");
const login = async (email) => (await call("/api/staff/login", { body: { email, password: "won12345" } })).setCookie.split(";")[0];
const desk = await login("desk@won.local");
const floor = await login("floor@won.local");
const owner = await login("owner@won.local");
ok((await call("/api/kpis", { cookie: desk })).status === 403, "desk cannot see KPIs");
ok((await call("/api/desk/today", { cookie: floor })).status === 403, "floor cannot use desk");
ok((await call("/api/runsheet", { cookie: floor })).status === 200, "floor can see runsheet");
ok((await call("/api/products/c1", { method: "PUT", cookie: desk, body: { pricePaise: 100, active: true } })).status === 403, "desk cannot change prices");

console.log("8. Walk-in → check-in with waiver gate (today)");
const wq = await call("/api/quote", { cookie: desk, body: { product: "c3", party: 3, date: today, channel: "desk" } });
ok(wq.j.offers.length > 0, `walk-in offers today (${wq.j.offers.length})`);
const walk = await call("/api/desk/walkin", { cookie: desk, body: { date: today, product: "c3", party: 3, start: wq.j.offers[0].start, name: "Walk In", phone: "9555555555", payment: "upi_counter" } });
ok(walk.status === 201 && walk.j.status === "confirmed", `walk-in confirmed at counter ${walk.j.code}`);
const comp = await call("/api/desk/walkin", { cookie: desk, body: { date: today, product: "c1", party: 1, start: wq.j.offers[0].start, name: "Comp", phone: "9555555556", payment: "comp", reason: "vip" } });
ok(comp.status === 403, "desk cannot issue comp tickets");
const ci1 = await call("/api/checkin", { cookie: desk, body: { scan: `WON:${walk.j.code}:${walk.j.token}` } });
ok(ci1.status === 409 && ci1.j.needWaivers, "check-in blocked: waivers missing");
await call(`/api/waivers/${walk.j.code}`, { cookie: desk, body: { guests: [{ name: "Walk In", ageBand: "18+", accept: true }, { name: "Friend One", ageBand: "18+", accept: true }] } });
const ci2 = await call("/api/checkin", { cookie: desk, body: { scan: walk.j.code, shrinkTo: 2 } });
ok(ci2.status === 200 && ci2.j.party === 2, "checked in 2 signed guests; party shrunk, seat released");
ok((await call("/api/checkin", { cookie: desk, body: { scan: walk.j.code } })).status === 409, "double check-in rejected");

console.log("9. Party booking (desk) with exclusive block");
const pq = await call("/api/quote", { cookie: desk, body: { product: "party_games", party: 12, date: addDays(today, 4), channel: "desk", preferredMin: 15 * 60 } });
ok(pq.j.offers.length > 0 && pq.j.offers[0].legs.length === 5, "party quote takes all 5 game rooms");
const pb = await call("/api/party-bookings", { cookie: desk, body: { date: addDays(today, 4), product: "party_games", party: 12, start: pq.j.offers[0].start, name: "Birthday Host", phone: "9666666666", food: true, payment: "online" } });
ok(pb.status === 201 && pb.j.amountDuePaise === Math.round(12 * 129900 * 0.25), `party held, deposit ₹${pb.j.amountDuePaise / 100}`);
const after = await call("/api/quote", { body: { product: "c1", party: 1, date: addDays(today, 4), preferredMin: pq.j.offers[0].start } });
const ps = pq.j.offers[0].start;
ok(!after.j.offers.some((o) => o.start < ps + 60 + 15 && o.end > ps - 30), "no game slots during party + setup/teardown");
const pLate = await call("/api/party-bookings", { cookie: desk, body: { date: tomorrow, product: "party_games", party: 12, start: 15 * 60, name: "Rush", phone: "9666666667", payment: "online" } });
ok(pLate.status === 400, "48 h party rule enforced for desk");

console.log("10. Owner: day config, prices, KPIs, runsheet");
const dc = await call(`/api/day-config/${wk}`, { method: "PUT", cookie: owner, body: { openMin: 660, closeMin: 1320, peak: "peak", holdbackPct: 50, deepCleanStart: 630, deepCleanMin: 30, deepCleanZone: "game", rotationHours: [12] } });
ok(dc.status === 200 && dc.j.peakHours.length === 11 && dc.j.rotationHours[0] === 12, "day config saved (holiday peak, pre-flagged 12:00 rotation hour)");
const bad19 = await call(`/api/day-config/${wk}`, { method: "PUT", cookie: owner, body: { openMin: 660, closeMin: 1320, peak: "auto", holdbackPct: 20, deepCleanStart: 990, deepCleanMin: 30, deepCleanZone: "game", rotationHours: [14] } });
ok(bad19.status === 409, "can't pre-flag a Rotation Hour that already holds 20-min legs");
const online = await call("/api/quote", { body: { product: "c1", party: 6, date: wk } });
ok(online.j.offers.length === 0, "50% hold-back: party of 6 can't buy a full room online at peak");
const deskQ = await call("/api/quote", { cookie: desk, body: { product: "c1", party: 6, date: wk, channel: "desk" } });
ok(deskQ.j.offers.length > 0, "…but the desk can (walk-in hold-back)");
const price = await call("/api/products/c1", { method: "PUT", cookie: owner, body: { pricePaise: 44900, active: true } });
ok(price.status === 200 && price.j.pricePaise === 44900, "owner changed Choice-of-1 price");
const kp = await call(`/api/kpis?week=${today}`, { cookie: owner });
ok(kp.status === 200 && kp.j.current.bookings > 0, `KPIs: ${kp.j.current.bookings} bookings, revenue ₹${kp.j.current.revenuePaise / 100}, RevPASH ₹${kp.j.current.revpashPaise / 100}`);
const rs = await call(`/api/runsheet?date=${wk}`, { cookie: floor });
ok(rs.j.rooms.length === 7 && rs.j.rotationHours.includes(19), "runsheet shows 7 rooms and the 19:00 Rotation Hour");
const audit = await call("/api/admin/audit", { cookie: owner });
ok(audit.j.events.some((e) => e.action === "product_updated") && audit.j.events.some((e) => e.action === "late_payment_refunded"), "audit feed has price change + refund");

console.log("11. Reschedule with OTP");
const otp = await call("/api/otp/send", { body: { phone: "9876543210" } });
const otpCode = otp.j.devCode ?? JSON.parse((await db.prepare("SELECT payload FROM messages WHERE template='otp' ORDER BY id DESC LIMIT 1").get()).payload).code;
const ver = await call("/api/otp/verify", { body: { phone: "9876543210", code: otpCode } });
const cust = ver.setCookie.split(";")[0];
// Use a booking ≥ 24 h out so the result doesn't depend on the time of day the suite runs.
const far = await call("/api/holds", { body: { product: "c3", party: 2, date: addDays(today, 3), start: 12 * 60, name: "Asha Rao", phone: "9876543210" } });
await call("/api/payments/mock", { body: { orderId: far.j.order.orderId, outcome: "success" } });
const near = await call(`/api/bookings/${hold.j.code}/reschedule`, { cookie: cust, body: { date: addDays(today, 5), start: 12 * 60 } });
const hoursToNear = (Date.parse(tomorrow + "T18:00:00+05:30") - Date.now()) / 3.6e6;
ok(hoursToNear >= 24 ? near.status === 200 || near.status === 409 : near.status === 403, `24 h rule applied to the booking ${hoursToNear.toFixed(0)} h away (${near.status})`);
const opts = await call(`/api/bookings/${far.j.code}/reschedule`, { cookie: cust, body: { date: addDays(today, 5) } });
ok(opts.j.offers?.length > 0, "reschedule options returned");
const mv = await call(`/api/bookings/${far.j.code}/reschedule`, { cookie: cust, body: { date: addDays(today, 5), start: opts.j.offers[0].start } });
ok(mv.status === 200, "moved once");
const mv2 = await call(`/api/bookings/${far.j.code}/reschedule`, { cookie: cust, body: { date: addDays(today, 6), start: opts.j.offers[0].start } });
ok(mv2.status === 403, "second free reschedule refused");
const stranger = await call(`/api/bookings/${walk.j.code}/reschedule`, { cookie: cust, body: { date: addDays(today, 5) } });
ok(stranger.status === 403, "can't reschedule someone else's booking");

console.log("12. Waitlist auto-offer on release");
// Fill splatter 13:30 session fully, join waitlist, then no-show/cancel releases it.
const s3 = 11 * 60 + 150;
const full = await call("/api/desk/walkin", { cookie: desk, body: { date: wk, product: "splat", party: 12, start: s3, name: "Big Group", phone: "9777777777", payment: "cash" } });
ok(full.status === 201, "13:30 splatter session full");
await call("/api/waitlist", { body: { date: wk, hour: 13, product: "splat", party: 4, name: "Waiter", phone: "9888888888" } });
const mgr = await login("manager@won.local");
const noPin = await call(`/api/bookings/${full.j.code}/cancel`, { cookie: desk, body: { reason: "group cancelled by phone" } });
ok(noPin.status === 403 && noPin.j.needPin, "cancel without manager PIN refused");
const badPin = await call(`/api/bookings/${full.j.code}/cancel`, { cookie: desk, body: { reason: "group cancelled by phone", managerPin: "0000" } });
ok(badPin.status === 403, "wrong manager PIN refused");
const okPin = await call(`/api/bookings/${full.j.code}/cancel`, { cookie: desk, body: { reason: "group cancelled by phone", managerPin: "2468" } });
ok(okPin.status === 200, "desk cancel approved by manager PIN at the counter");
// The offer is made in the background after the cancel responds; poll for it (remote DB latency varies).
let wl;
for (let i = 0; i < 25; i++) {
  await new Promise((r) => setTimeout(r, 200));
  wl = (await db.prepare("SELECT state, offer_start, token FROM waitlist WHERE day = ?").get(wk));
  if (wl?.state === "offered") break;
}
ok(wl.state === "offered" && wl.offer_start === s3, `waitlist offered ${wl.offer_start}`);
const acc = await call(`/api/waitlist/${wl.token}`, { method: "POST", body: {} });
ok(acc.status === 201 && acc.j.status === "hold", "waitlister accepted → hold → payment");

console.log("13. Comp tickets & overrides via manager PIN");
const comp2 = await call("/api/desk/walkin", { cookie: desk, body: { date: today, product: "c1", party: 1, start: wq.j.offers[0].start, name: "VIP", phone: "9555555557", payment: "comp", reason: "influencer visit", managerPin: "2468" } });
ok(comp2.status === 201 && comp2.j.pricePaise === 0, "comp ticket issued with manager PIN, ₹0");
ok((await db.prepare("SELECT notes FROM bookings WHERE code = ?").get(comp2.j.code)).notes.includes("approved by manager@won.local"), "approver recorded on booking (unique PINs)");
const ownerComp = await call("/api/desk/walkin", { cookie: desk, body: { date: today, product: "c1", party: 1, start: wq.j.offers[0].start, name: "VIP2", phone: "9555555558", payment: "comp", reason: "owner guest", managerPin: "1357" } });
ok((await db.prepare("SELECT notes FROM bookings WHERE code = ?").get(ownerComp.j.code))?.notes.includes("approved by owner@won.local"), "owner's PIN attributed to owner");
const rush = await call("/api/party-bookings", { cookie: desk, body: { date: tomorrow, product: "party_neon", party: 10, start: 14 * 60 + 45, name: "Rush", phone: "9666666668", payment: "cash", overrideLead: true, managerPin: "2468" } });
ok(rush.status === 201, "short-notice party allowed with manager PIN override");

console.log("14. Flash prices (dead-slot rescue)");
const fl = await call("/api/flash-offers", { cookie: mgr, body: { date: addDays(today, 6), product: "c3", startHour: 11, endHour: 13, pricePaise: 79900 } });
const flDay = addDays(today, 6);
const flPeak = new Date(flDay + "T00:00:00Z").getUTCDay();
if ([0, 6].includes(flPeak)) ok(fl.status === 409, "flash price refused on a peak (weekend) day");
else {
  ok(fl.status === 201, "flash price opened for 11:00–13:00");
  const fq = await call("/api/quote", { body: { product: "c3", party: 2, date: flDay, preferredMin: 11 * 60 } });
  const f11 = fq.j.offers.find((o) => o.start === 11 * 60);
  ok(f11?.flash && f11.pricePaise === 2 * 79900 && f11.basePricePaise === 2 * 99900, "11:00 offer carries flash price ₹1,598 (was ₹1,998)");
  const later = fq.j.offers.find((o) => o.start >= 13 * 60);
  ok(!later || !later.flash, "flash price doesn't apply outside its hours");
  const fh = await call("/api/holds", { body: { product: "c3", party: 2, date: flDay, start: 11 * 60, name: "Bargain", phone: "9123456780" } });
  ok(fh.j.amountDuePaise === 159800, "hold charges the flash price");
}
ok((await call("/api/flash-offers", { cookie: desk, body: { date: flDay, product: "c3", startHour: 11, endHour: 12, pricePaise: 50000 } })).status === 403, "desk can't open flash prices");

console.log("15. Member peak horizon");
await call("/api/memberships", { cookie: mgr, body: { name: "Member", phone: "9012345678", plan: "Annual Games", months: 12, visits: 10 } });
let peakDay = addDays(today, 3);
while (![0, 6].includes(new Date(peakDay + "T00:00:00Z").getUTCDay())) peakDay = addDays(peakDay, 1);
const mq = await call("/api/quote", { cookie: desk, body: { product: "c1", party: 1, date: peakDay, channel: "desk", preferredMin: 17 * 60 } });
const mb = await call("/api/desk/walkin", { cookie: desk, body: { date: peakDay, product: "c1", party: 1, start: mq.j.offers[0].start, name: "Member", phone: "9012345678", payment: "membership", source: "phone" } });
ok(mb.status === 400 && /2 days ahead/.test(mb.j.error), `member peak visit > 2 days ahead refused (${mb.j.error})`);
const mq2 = await call("/api/quote", { cookie: desk, body: { product: "c1", party: 1, date: today, channel: "desk" } });
const mb2 = await call("/api/desk/walkin", { cookie: desk, body: { date: today, product: "c1", party: 1, start: mq2.j.offers[0].start, name: "Member", phone: "9012345678", payment: "membership" } });
ok(mb2.status === 201, "member visit today allowed");

console.log("16. Staff 2FA (TOTP)");
const setup = await call("/api/staff/security", { cookie: owner, body: { action: "totp-setup" } });
ok(setup.j.secret && setup.j.qr?.startsWith("data:image"), "TOTP secret + QR issued");
const { totpAt } = await import("../src/lib/totp.ts").catch(() => ({ totpAt: null }));
const code = totpAt ? totpAt(setup.j.secret, Math.floor(Date.now() / 30000)) : null;
if (code) {
  ok((await call("/api/staff/security", { cookie: owner, body: { action: "totp-enable", code } })).status === 200, "2FA enabled");
  const l1 = await call("/api/staff/login", { body: { email: "owner@won.local", password: "won12345" } });
  ok(l1.status === 401 && l1.j.needTotp, "login now asks for authenticator code");
  const l2 = await call("/api/staff/login", { body: { email: "owner@won.local", password: "won12345", totp: "000000" } });
  ok(l2.status === 401, "wrong code refused");
  const l3 = await call("/api/staff/login", { body: { email: "owner@won.local", password: "won12345", totp: totpAt(setup.j.secret, Math.floor(Date.now() / 30000)) } });
  ok(l3.status === 200, "correct code logs in");
} else console.log("  (skipped TOTP enable: run with tsx to import src/lib/totp.ts)");

console.log("17. GST export & health");
const gst = await fetch(`${BASE}/api/admin/gst-export?month=${today.slice(0, 7)}`, { headers: { cookie: mgr } });
const csvText = await gst.text();
ok(gst.status === 200 && csvText.startsWith("Invoice No,") && csvText.includes("WON/") && csvText.includes("TOTAL"), `GST CSV: ${csvText.trim().split("\n").length - 2} invoices`);
const health = await call("/api/health");
ok(health.status === 200 && health.j.ok, `health: ledger invariant holds over ${health.j.checkedDays} days`);


console.log("18. Guest list edits until check-in");
const g1 = await call(`/api/bookings/${hold.j.code}/guests?t=${hold.j.token}`, { method: "PUT", body: { guests: [{ name: "Asha Rao", ageBand: "18+" }, { name: "Kiran" }] } });
ok(g1.status === 200 && g1.j.guests.length === 2, "leader saves 2 guest names");
const g2 = await call(`/api/bookings/${hold.j.code}/guests?t=${hold.j.token}`, { method: "PUT", body: { guests: Array.from({ length: 5 }, (_, i) => ({ name: `G${i}` })) } });
ok(g2.status === 400, "more names than the party size refused");
const gv = await call(`/api/bookings/${hold.j.code}?t=${hold.j.token}`);
ok(gv.j.guests?.length === 2 && gv.j.canEditGuests && gv.j.start === 18 * 60, "guest list shown, schedule untouched");
const g3 = await call(`/api/bookings/${hold.j.code}/guests?t=wrongtoken000000`, { method: "PUT", body: { guests: [] } });
ok(g3.status === 403, "guest edit needs the booking token");

console.log("19. Customer membership view (OTP)");
ok((await call("/api/me")).status === 401, "/api/me needs OTP login");
const mo = await call("/api/otp/send", { body: { phone: "9012345678" } });
ok(mo.status === 200, "OTP sent to member");
ok((await call("/api/otp/send", { body: { phone: "9012345678" } })).status === 429, "second OTP within 30 s refused (per-phone limit)");
const moCode = mo.j.devCode ?? JSON.parse((await db.prepare("SELECT payload FROM messages WHERE template='otp' AND to_phone LIKE '%9012345678' ORDER BY id DESC LIMIT 1").get()).payload).code;
const meVerify = await call("/api/otp/verify", { body: { phone: "9012345678", code: moCode } });
const meCookie = meVerify.setCookie?.split(";")[0];
const me = await call("/api/me", { cookie: meCookie });
ok(me.status === 200 && me.j.memberships.length === 1 && me.j.memberships[0].visits_left === 10 && me.j.memberships[0].active, `member sees plan, ${me.j.memberships?.[0]?.visits_left} visits left`);
ok(me.j.bookings.some((b) => b.code === mb2.j.code), "member sees upcoming booking");
ok((await call("/api/me", { method: "DELETE", cookie: meCookie })).status === 200, "sign out");

console.log("20. Manual room blocks (staff breaks, maintenance)");
const gameRooms = ["arena", "climb", "push", "lazer", "grid"];
ok((await call("/api/blocks", { cookie: desk, body: { date: wk, rooms: ["arena"], startMin: 900, endMin: 920, kind: "Staff break" } })).status === 403, "desk can't add blocks");
const blk = await call("/api/blocks", { cookie: mgr, body: { date: wk, rooms: gameRooms, startMin: 900, endMin: 920, kind: "Maintenance", note: "LED check" } });
ok(blk.status === 201 && blk.j.ids.length === 5, "manager blocks all game rooms 15:00–15:20");
const bq = await call("/api/quote", { body: { product: "c1", party: 1, date: wk, preferredMin: 900 } });
ok(bq.status === 200 && !bq.j.offers.some((o) => o.start === 900), "blocked slot is not sold");
const busyBlk = await call("/api/blocks", { cookie: mgr, body: { date: tomorrow, rooms: gameRooms, startMin: 18 * 60, endMin: 18 * 60 + 20, kind: "Staff break" } });
ok(busyBlk.status === 409, "can't block a room with booked guests in it");
const lb = await call(`/api/blocks?date=${wk}`, { cookie: desk });
ok(lb.j.blocks.length === 5 && lb.j.blocks[0].reason === "Maintenance: LED check", "blocks listed with reason");
for (const id of blk.j.ids) await call(`/api/blocks/${id}`, { method: "DELETE", cookie: mgr });
const bq2 = await call("/api/quote", { body: { product: "c1", party: 1, date: wk, preferredMin: 900 } });
ok(bq2.j.offers.some((o) => o.start === 900), "removing the block reopens 15:00");

console.log("21. Price changes with an effective-from date");
const effDay = addDays(today, 10);
const c1Now = (await call("/api/products")).j.products.find((p) => p.id === "c1").pricePaise;
ok((await call("/api/price-schedule", { cookie: mgr, body: { productId: "c1", effectiveFrom: effDay, pricePaise: 54900 } })).status === 403, "only the owner schedules prices");
const psNew = await call("/api/price-schedule", { cookie: owner, body: { productId: "c1", effectiveFrom: effDay, pricePaise: 54900 } });
ok(psNew.status === 201, "c1 ₹549 scheduled from day +10");
const priceBefore = await call("/api/quote", { body: { product: "c1", party: 2, date: addDays(effDay, -1) } });
const priceAfter = await call("/api/quote", { body: { product: "c1", party: 2, date: effDay } });
ok(priceBefore.j.offers[0]?.pricePaise === 2 * c1Now && priceAfter.j.offers[0]?.pricePaise === 2 * 54900, `day priceBefore ₹${priceBefore.j.offers[0]?.pricePaise / 100}, from the date ₹${priceAfter.j.offers[0]?.pricePaise / 100}`);
ok((await call("/api/products")).j.products.find((p) => p.id === "c1").pricePaise === c1Now, "catalogue still shows today's price");
const psl = await call("/api/price-schedule", { cookie: mgr });
ok(psl.j.scheduled.some((r) => r.product_id === "c1" && r.effective_from === effDay), "scheduled change listed");

console.log("22. All 5 as 5 × 20 min + rejection log");
const a5Day = addDays(wk, 7);
const cfg0 = (await call(`/api/day-config/${a5Day}`, { cookie: mgr })).j;
const cfgBody = (o) => ({ openMin: cfg0.openMin, closeMin: cfg0.closeMin, peak: "auto", holdbackPct: cfg0.holdbackPct, deepCleanStart: cfg0.deepCleanStart, deepCleanMin: cfg0.deepCleanMin, deepCleanZone: cfg0.deepCleanZone, rotationHours: [], ...o });
const rej0 = (await db.prepare("SELECT COUNT(*) AS n FROM quote_rejections").get()).n;
await call(`/api/day-config/${a5Day}`, { method: "PUT", cookie: mgr, body: cfgBody({ closeMin: 12 * 60, all5Mode: "grid" }) });
const none = await call("/api/quote", { body: { product: "a5", party: 2, date: a5Day } });
ok(none.j.offers.length === 0, "100-min All 5 can't fit a 1-hour day");
const rej = (await db.prepare("SELECT * FROM quote_rejections ORDER BY id DESC LIMIT 1").get());
ok((await db.prepare("SELECT COUNT(*) AS n FROM quote_rejections").get()).n === rej0 + 1 && rej.false_sellout === 0, "rejection logged, not a false sell-out");
const set5 = await call(`/api/day-config/${a5Day}`, { method: "PUT", cookie: mgr, body: cfgBody({ all5Mode: "grid" }) });
ok(set5.j.all5Mode === "grid" && set5.j.all5Override === "grid", "day set to All 5 = 5 × 20 min");
const g5 = await call("/api/quote", { body: { product: "a5", party: 2, date: a5Day, preferredMin: 12 * 60 } });
const o5 = g5.j.offers[0];
ok(o5 && o5.legs.length === 5 && o5.end - o5.start === 100 && o5.legs.every((l, i) => l.end - l.start === 20 && (i === 0 || l.start === o5.legs[i - 1].end)) && new Set(o5.legs.map((l) => l.roomId)).size === 5, `All 5 offered ${o5?.start / 60}:00 as 5 distinct 20-min legs`);
const h5 = await call("/api/holds", { body: { product: "a5", party: 2, date: a5Day, start: o5.start, name: "Grid Five", phone: "9100000005" } });
ok(h5.status === 201, "grid-mode All 5 held");
const c1Same = await call("/api/quote", { body: { product: "c1", party: 6, date: a5Day, preferredMin: o5.start } });
ok(c1Same.status === 200, "20-min products still sell around it (same cadence)");
const kpi2 = await call(`/api/kpis?week=${a5Day}`, { cookie: mgr });
ok(kpi2.j.current.rejections >= 1 && kpi2.j.current.falseSellouts === 0 && "walkInConversion" in kpi2.j.current, `KPIs: ${kpi2.j.current.rejections} rejection(s), false sell-out rate ${kpi2.j.current.falseSelloutRate}`);

console.log("23. Owner-approved refund exception");
const rf0 = await call(`/api/bookings/${hold.j.code}/refund`, { cookie: mgr, body: { amountPaise: 100000, reason: "owner goodwill", managerPin: "2468" } });
ok(rf0.status === 403, "manager PIN is not enough for a refund");
ok((await call(`/api/bookings/${hold.j.code}/refund`, { cookie: desk, body: { amountPaise: 100000, reason: "x", managerPin: "1357" } })).status === 403, "desk can't start a refund");
const rf = await call(`/api/bookings/${hold.j.code}/refund`, { cookie: mgr, body: { amountPaise: 100000, reason: "owner goodwill", managerPin: "1357" } });
ok(rf.status === 200 && rf.j.via === "gateway", "owner PIN → ₹1,000 refunded via the gateway");
const rf2 = await call(`/api/bookings/${hold.j.code}/refund`, { cookie: mgr, body: { amountPaise: 400000, reason: "too much", managerPin: "1357" } });
ok(rf2.status === 400, "can't refund more than was paid");
const rv = await call(`/api/bookings/${hold.j.code}?t=${hold.j.token}`);
ok(rv.j.refundedPaise === 100000 && rv.j.status === "confirmed", "refund recorded; booking kept (cancel not ticked)");
ok((await db.prepare("SELECT detail FROM events_audit WHERE action = 'refund_owner_approved' ORDER BY id DESC LIMIT 1").get())?.detail.includes("owner@won.local"), "audit names the owner as approver");

console.log("24. Crash recovery: rebuild, compare, pause sales");
(await db.prepare("UPDATE bookings SET party_size = 60 WHERE code = ?").run(hold.j.code)); // simulate a corrupt row (60 guests in a 6-seat room)
const hBad = await call("/api/health");
ok(hBad.status === 503 && hBad.j.bookingsPaused && hBad.j.problems.length > 0, `health 503, bookings paused: ${hBad.j.problems?.[0]}`);
const blocked = await call("/api/holds", { body: { product: "c1", party: 1, date: wk, start: 12 * 60, name: "Blocked", phone: "9100000006" } });
ok(blocked.status === 503, "new bookings refused while paused");
const ig = await call("/api/admin/integrity", { cookie: mgr });
ok(ig.j.lock && ig.j.problems.length > 0, "dashboard shows the lock and the problem");
const stillBad = await call("/api/admin/integrity", { cookie: mgr, body: { action: "recheck" } });
ok(stillBad.j.lock, "re-check keeps the pause while the problem exists");
(await db.prepare("UPDATE bookings SET party_size = 4 WHERE code = ?").run(hold.j.code));
const fixed = await call("/api/admin/integrity", { cookie: mgr, body: { action: "recheck" } });
ok(!fixed.j.lock && fixed.j.problems.length === 0, "fixed + re-checked → sales reopen");
const freeQ = await call("/api/quote", { body: { product: "c1", party: 1, date: wk } });
const unblocked = await call("/api/holds", { body: { product: "c1", party: 1, date: wk, start: freeQ.j.offers[0].start, name: "Unblocked", phone: "9100000006" } });
ok(unblocked.status === 201, `bookings work again (${unblocked.status} ${unblocked.j.error ?? ""})`);
const hOk = await call("/api/health");
ok(hOk.status === 200 && hOk.j.ok, "health back to 200");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
