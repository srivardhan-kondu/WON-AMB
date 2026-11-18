// Simulated Saturday + engine self-checks (§11 of the algorithm doc).
// Run: npm run simulate   (exits non-zero if any invariant fails)

import {
  DEFAULT_PRODUCTS,
  DEFAULT_ROOMS,
  Ledger,
  defaultDayConfig,
  quote,
  stillFits,
  type LedgerBooking,
  type Product,
} from "../src/lib/engine";

let seed = Number(process.env.SEED ?? 7);
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const day = "2026-11-21"; // a Saturday
const cfg = defaultDayConfig(day);
const products = new Map(DEFAULT_PRODUCTS.map((p) => [p.id, p]));
const bookings: (LedgerBooking & { productId: string; price: number })[] = [];
let ledger = new Ledger(DEFAULT_ROOMS, cfg);

const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
};

function commit(p: Product, party: number, preferred: number | null, chosen?: string[]) {
  const t0 = performance.now();
  const res = quote(ledger, p, { productId: p.id, party, preferredMin: preferred, chosenRooms: chosen, channel: "desk" });
  quoteTimes.push(performance.now() - t0);
  const offer = res.offers[0];
  if (!offer) return false;
  check(stillFits(ledger, p, party, offer.legs, offer.blocks), `offer not re-verifiable for ${p.id}`);
  const b = { id: bookings.length + 1, shape: p.shape, party, exclusive: p.shape === "party", legs: offer.legs, productId: p.id, price: offer.pricePaise };
  bookings.push(b);
  if (offer.blocks) partyBlocks.push(...offer.blocks);
  ledger = new Ledger(DEFAULT_ROOMS, cfg, bookings, partyBlocks);
  return true;
}
const partyBlocks: { roomId: string; start: number; end: number; reason: string }[] = [];
const quoteTimes: number[] = [];

// Pre-booked 12-guest birthday party at 18:00.
commit(products.get("party_games")!, 12, 18 * 60);

// 73 realistic requests: families midday, all-5 groups and parties in the evening.
let requests = 0;
let seated = 0;
for (let i = 0; i < 73; i++) {
  const hour = 11 + Math.floor(rand() * 10);
  const evening = hour >= 17;
  const r = rand();
  let pid: string;
  if (r < 0.15) pid = "c1";
  else if (r < 0.52) pid = "c3";
  else if (r < (evening ? 0.85 : 0.72)) pid = "a5";
  else pid = "splat";
  const p = products.get(pid)!;
  const party = pid === "splat" ? 2 + Math.floor(rand() * 5) : 1 + Math.floor(rand() * Math.min(6, p.maxParty));
  const chosen = pid === "c3" && rand() < 0.3 ? shuffle(["arena", "climb", "push", "lazer", "grid"]).slice(0, 3) : undefined;
  requests++;
  if (commit(p, party, hour * 60 + pick([0, 20, 40]), chosen)) seated++;
}

function shuffle<T>(xs: T[]) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Invariants ----
check(ledger.overCapacity().length === 0, `capacity: ${ledger.overCapacity().join("; ")}`);
for (const b of bookings) {
  const game = b.legs.filter((l) => DEFAULT_ROOMS.find((r) => r.id === l.roomId)!.zone === "game");
  if (b.shape === "grid20" || b.shape === "rotation" || b.shape === "combo") {
    check(new Set(game.map((l) => l.roomId)).size === game.length, `booking ${b.id}: repeated room`);
    for (let k = 1; k < game.length; k++) check(game[k].start === game[k - 1].end, `booking ${b.id}: gap between legs`);
  }
  for (const l of b.legs) {
    check(l.start >= cfg.openMin && l.end <= cfg.closeMin, `booking ${b.id}: outside opening hours`);
    for (const blk of ledger.blocks) {
      if (!b.exclusive && blk.roomId === l.roomId && l.start < blk.end && blk.start < l.end)
        check(false, `booking ${b.id} overlaps ${blk.reason} in ${l.roomId}`);
    }
  }
}
// The 12-min and 20-min cadences never mix in the same hour.
for (let h = 0; h < 24; h++) check(!(ledger.rotLegs[h] > 0 && ledger.gridLegs[h] > 0), `hour ${h}: cadences mixed`);

// Matching beats first-fit: a scenario where first-fit falsely sells out.
{
  const l2 = new Ledger(DEFAULT_ROOMS, cfg, [
    { id: "x1", shape: "grid20", party: 6, exclusive: false, legs: [{ roomId: "arena", start: 1020, end: 1040 }, { roomId: "climb", start: 1040, end: 1060 }] },
    { id: "x2", shape: "grid20", party: 6, exclusive: false, legs: [{ roomId: "push", start: 1020, end: 1040 }, { roomId: "grid", start: 1040, end: 1060 }, { roomId: "push", start: 1060, end: 1080 }] },
  ]);
  const res = quote(l2, products.get("c3")!, { productId: "c3", party: 4, channel: "desk", exactStart: 1020 });
  check(res.offers.length === 1, "matching should find a rotation where first-fit would not");
}

// Neon-zone parties are bookable (take over a whole splatter session, cleanups untouched).
{
  const l3 = new Ledger(DEFAULT_ROOMS, cfg);
  const res = quote(l3, products.get("party_neon")!, { productId: "party_neon", party: 12, channel: "desk" });
  check(res.offers.length > 0, "Neon-zone party should be bookable on an empty day");
  for (const o of res.offers) for (const b of l3.blocks) for (const l of o.legs)
    check(!(b.roomId === l.roomId && l.start < b.end && b.start < l.end), `Neon party at ${o.start} overlaps ${b.reason}`);
}

// ---- Report ----
const byProduct = new Map<string, { n: number; guests: number; rev: number }>();
for (const b of bookings) {
  const e = byProduct.get(b.productId) ?? { n: 0, guests: 0, rev: 0 };
  e.n++;
  e.guests += b.party;
  e.rev += b.price;
  byProduct.set(b.productId, e);
}
console.log(`Simulated Saturday ${day} (seed ${process.env.SEED ?? 7})`);
console.log(`Requests seated: ${seated}/${requests} (+1 pre-booked party)`);
let total = 0;
for (const [pid, e] of byProduct) {
  total += e.rev;
  console.log(`  ${products.get(pid)!.name.padEnd(36)} ${String(e.n).padStart(3)} bookings ${String(e.guests).padStart(4)} guests  ₹${(e.rev / 100).toLocaleString("en-IN")}`);
}
console.log(`  ${"TOTAL".padEnd(36)} ${String(bookings.length).padStart(3)} bookings  ₹${(total / 100).toLocaleString("en-IN")}`);
const rotHours = [...ledger.rotLegs].map((v, h) => (v > 0 ? h : -1)).filter((h) => h >= 0);
console.log(`Rotation Hours that self-organized: ${rotHours.join(", ") || "none"}`);
const sorted = [...quoteTimes].sort((a, b) => a - b);
console.log(`Quote latency: median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} ms, max ${sorted[sorted.length - 1].toFixed(2)} ms`);

if (failures.length) {
  console.error(`\n✗ ${failures.length} invariant failure(s):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("\n✓ All invariants hold: no room over capacity, legs gap-free in distinct rooms, buffers untouched, cadences never mixed.");
