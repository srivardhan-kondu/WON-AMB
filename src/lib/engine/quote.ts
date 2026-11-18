// §5 The core booking algorithm: quote → assign → score.
// Holds and commits live in the booking service; quotes are stateless.

import { Ledger, splatterStarts } from "./ledger";
import type { Block, Leg, Offer, Product, QuoteRequest, QuoteResult, Room } from "./types";

export const WEIGHTS = { consolidation: 3, fragmentation: 4, preference: 5, steer: 1 };
export const INTER_ZONE_BUFFER = 15;
export const PARTY_SETUP = 30;
export const PARTY_TEARDOWN = 15;

export function priceFor(p: Product, party: number): number {
  if (p.pricing === "pack4") return p.pricePaise + Math.max(0, party - 4) * p.extraPaise;
  return p.pricePaise * party;
}

export function isPeakMinute(ledger: Ledger, m: number): boolean {
  return ledger.cfg.peakHours.includes(Math.floor(m / 60));
}

/** Effective capacity of a room for this channel at this start (§8.3 walk-in hold-back). */
function capFor(ledger: Ledger, room: Room, start: number, req: QuoteRequest): number {
  if (req.channel !== "online" || room.zone !== "game") return room.capacity;
  if (!isPeakMinute(ledger, start)) return room.capacity;
  // Hold-back is released 2 h before the slot.
  if (req.nowMin != null && start - req.nowMin <= 120) return room.capacity;
  return room.capacity - Math.floor((room.capacity * ledger.cfg.holdbackPct) / 100);
}

/** Can a 20-min-grid leg run in this hour without colliding with a Rotation Hour? */
function gridHourOk(ledger: Ledger, start: number): boolean {
  const h = Math.floor(start / 60);
  return ledger.rotLegs[h] === 0 && !ledger.cfg.rotationHours.includes(h);
}

function rotationHourOk(ledger: Ledger, hourStart: number): boolean {
  return ledger.gridLegs[Math.floor(hourStart / 60)] === 0;
}

/**
 * match_distinct: pick one DISTINCT room per leg. With ≤5 legs this brute-forces ≤120
 * orderings; it finds a valid assignment whenever one exists (Hall's theorem), so
 * "room free but not sellable" cannot happen.
 * Tie-break: prefer rooms already partially committed in that leg (consolidation),
 * then spread wear across rooms.
 */
export function matchDistinct(ledger: Ledger, candidates: string[][], legs: { start: number; end: number }[]): string[] | null {
  let best: string[] | null = null;
  let bestScore = -Infinity;
  const used = new Set<string>();
  const pick: string[] = [];
  const dayLoad = new Map<string, number>();
  for (const set of candidates) for (const r of set) if (!dayLoad.has(r)) dayLoad.set(r, ledger.load(r));

  const dfs = (i: number) => {
    if (i === candidates.length) {
      let s = 0;
      for (let k = 0; k < pick.length; k++) {
        if (ledger.occAt(pick[k], legs[k].start) > 0) s += 10;
        s -= (dayLoad.get(pick[k]) ?? 0) / 10000;
      }
      if (s > bestScore) {
        bestScore = s;
        best = [...pick];
      }
      return;
    }
    for (const r of candidates[i]) {
      if (used.has(r)) continue;
      used.add(r);
      pick.push(r);
      dfs(i + 1);
      pick.pop();
      used.delete(r);
    }
  };
  dfs(0);
  return best;
}

interface Candidate {
  start: number;
  legs: Leg[];
  blocks?: Block[];
}

function gameRooms(ledger: Ledger, allowed?: string[] | null): string[] {
  const all = ledger.roomsInZone("game").map((r) => r.id);
  if (!allowed || allowed.length === 0) return all;
  return all.filter((r) => allowed.includes(r));
}

/** Candidate rooms per leg (S[i] in §5) for back-to-back game legs starting at t, or null if a leg has none. */
function legSets(ledger: Ledger, req: QuoteRequest, t: number, count: number, legMin: number, mode: "grid" | "rotation") {
  const allowed = gameRooms(ledger, req.chosenRooms);
  if (allowed.length < count) return null;
  const intervals = Array.from({ length: count }, (_, i) => ({ start: t + i * legMin, end: t + (i + 1) * legMin }));
  if (mode === "grid" && intervals.some((iv) => !gridHourOk(ledger, iv.start))) return null;
  const S = intervals.map((iv) =>
    allowed.filter((r) => ledger.fits(r, iv.start, iv.end, req.party, capFor(ledger, ledger.room(r), iv.start, req))),
  );
  if (S.some((s) => s.length === 0)) return null;
  return { intervals, S };
}

/** Assign rooms for back-to-back game legs starting at t. Returns legs or null. */
function assignGameLegs(
  ledger: Ledger,
  req: QuoteRequest,
  t: number,
  count: number,
  legMin: number,
  mode: "grid" | "rotation",
): Leg[] | null {
  const sets = legSets(ledger, req, t, count, legMin, mode);
  if (!sets) return null;
  const rooms = matchDistinct(ledger, sets.S, sets.intervals);
  if (!rooms) return null;
  return sets.intervals.map((iv, i) => ({ roomId: rooms[i], start: iv.start, end: iv.end }));
}

/** Hall's condition, checked independently of matchDistinct: every k legs together can use ≥ k distinct rooms. */
export function hallFeasible(S: string[][]): boolean {
  const n = S.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const union = new Set<string>();
    let k = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { k++; for (const r of S[i]) union.add(r); }
    if (union.size < k) return false;
  }
  return true;
}

/**
 * §12 false sell-out audit: starts where every leg had a free room and a distinct assignment exists
 * (Hall's theorem) but the engine produced no offer. Must be 0 by construction — nonzero is a bug.
 */
export function falseSellouts(ledger: Ledger, p: Product | undefined, req: QuoteRequest): number {
  if (!p || validate(p, req)) return 0;
  const { offers } = quote(ledger, p, { ...req, limit: 1000 });
  const offered = new Set(offers.map((o) => o.start));
  const shape = gameShape(ledger, p);
  if (!shape) return 0;
  let bad = 0;
  for (const t of shape.starts) {
    if (!inWindowOf(req)(t) || offered.has(t)) continue;
    const sets = legSets(ledger, shape.rotation ? { ...req, chosenRooms: null } : req, t, shape.count, shape.legMin, shape.rotation ? "rotation" : "grid");
    if (shape.rotation && !rotationHourOk(ledger, t)) continue;
    if (p.shape === "combo") continue; // the splatter half can legitimately be full
    if (sets && hallFeasible(sets.S)) bad++;
  }
  return bad;
}

function gameShape(ledger: Ledger, p: Product) {
  const { openMin, closeMin } = ledger.cfg;
  const grid = (count: number) => {
    const starts: number[] = [];
    for (let t = Math.ceil(openMin / 20) * 20; t + count * 20 <= closeMin; t += 20) starts.push(t);
    return { starts, count, legMin: 20, rotation: false };
  };
  if (p.shape === "grid20") return grid(p.legs);
  if (p.shape === "rotation") {
    if (ledger.cfg.all5Mode === "grid") return grid(5);
    const starts: number[] = [];
    for (let t = Math.ceil(openMin / 60) * 60; t + 60 <= closeMin; t += 60) starts.push(t);
    return { starts, count: 5, legMin: 12, rotation: true };
  }
  return null;
}

function inWindowOf(req: QuoteRequest) {
  return (t: number) =>
    (req.notBefore == null || t >= req.notBefore) &&
    (req.windowStart == null || t >= req.windowStart) &&
    (req.windowEnd == null || t < req.windowEnd) &&
    (req.exactStart == null || t === req.exactStart);
}

function splatterLegs(ledger: Ledger, req: QuoteRequest, s: number): Leg[] | null {
  const rooms = ledger.roomsInZone("splatter");
  if (rooms.length === 0) return null;
  for (const r of rooms) if (!ledger.fits(r.id, s, s + 60, req.party)) return null;
  return rooms.map((r) => ({ roomId: r.id, start: s, end: s + 60 }));
}

function candidateStarts(ledger: Ledger, p: Product, req: QuoteRequest): Candidate[] {
  const { openMin, closeMin } = ledger.cfg;
  const out: Candidate[] = [];
  const inWindow = inWindowOf(req);

  switch (p.shape) {
    case "grid20": {
      const span = p.legs * 20;
      for (let t = Math.ceil(openMin / 20) * 20; t + span <= closeMin; t += 20) {
        if (!inWindow(t)) continue;
        const legs = assignGameLegs(ledger, req, t, p.legs, 20, "grid");
        if (legs) out.push({ start: t, legs });
      }
      break;
    }
    case "rotation": {
      if (ledger.cfg.all5Mode === "grid") {
        // §3.3 config flag: All 5 sold as a 100-min product (5 × 20-min legs) on the single 20-min cadence.
        for (let t = Math.ceil(openMin / 20) * 20; t + 100 <= closeMin; t += 20) {
          if (!inWindow(t)) continue;
          const legs = assignGameLegs(ledger, { ...req, chosenRooms: null }, t, 5, 20, "grid");
          if (legs) out.push({ start: t, legs });
        }
        break;
      }
      for (let t = Math.ceil(openMin / 60) * 60; t + 60 <= closeMin; t += 60) {
        if (!inWindow(t) || !rotationHourOk(ledger, t)) continue;
        const legs = assignGameLegs(ledger, { ...req, chosenRooms: null }, t, 5, 12, "rotation");
        if (legs) out.push({ start: t, legs });
      }
      break;
    }
    case "splatter": {
      for (const s of splatterStarts(ledger.cfg)) {
        if (!inWindow(s)) continue;
        const legs = splatterLegs(ledger, req, s);
        if (legs) out.push({ start: s, legs });
      }
      break;
    }
    case "combo": {
      // Games hour (3 × 20) → ≥15-min inter-zone buffer → splatter session, booked atomically.
      for (const s of splatterStarts(ledger.cfg)) {
        const t = Math.floor((s - 60 - INTER_ZONE_BUFFER) / 20) * 20;
        if (t < openMin || !inWindow(t)) continue;
        const games = assignGameLegs(ledger, req, t, 3, 20, "grid");
        if (!games) continue;
        const splat = splatterLegs(ledger, req, s);
        if (!splat) continue;
        out.push({ start: t, legs: [...games, ...splat] });
      }
      break;
    }
    case "party": {
      const rooms = ledger.roomsInZone(p.zone);
      const dur = p.durationMin || 60;
      if (p.zone === "splatter") {
        // The Splatter Zone runs on a fixed 75-min cadence whose 15-min paint cleanups are permanent
        // buffers, so a party takes over one whole session: the previous cleanup is its setup and its
        // own cleanup is the teardown. No extra blocks — and no window can ever straddle a cleanup.
        for (const t of splatterStarts(ledger.cfg)) {
          if (!inWindow(t) || dur > 60) continue;
          if (!rooms.every((r) => ledger.empty(r.id, t, t + dur))) continue;
          out.push({ start: t, legs: rooms.map((r) => ({ roomId: r.id, start: t, end: t + dur })), blocks: [] });
        }
        break;
      }
      // Game Zone: exclusive whole-zone block on the hour, with setup before and teardown after.
      for (let t = Math.ceil(openMin / 60) * 60; t + dur <= closeMin; t += 60) {
        if (!inWindow(t)) continue;
        const ok = rooms.every((r) => ledger.empty(r.id, t - PARTY_SETUP, t + dur + PARTY_TEARDOWN));
        if (!ok) continue;
        out.push({
          start: t,
          legs: rooms.map((r) => ({ roomId: r.id, start: t, end: t + dur })),
          blocks: rooms.flatMap((r) => [
            { roomId: r.id, start: t - PARTY_SETUP, end: t, reason: "Party setup" },
            { roomId: r.id, start: t + dur, end: t + dur + PARTY_TEARDOWN, reason: "Party teardown" },
          ]),
        });
      }
      break;
    }
  }
  return out;
}

function zoneCapacityMinutes(ledger: Ledger, zone: string, start: number, end: number) {
  let cap = 0;
  let load = 0;
  for (const r of ledger.roomsInZone(zone)) {
    cap += r.capacity * (end - start);
    load += ledger.load(r.id, start, end);
  }
  return cap === 0 ? 0 : load / cap;
}

function score(ledger: Ledger, p: Product, req: QuoteRequest, c: Candidate): number {
  const end = Math.max(...c.legs.map((l) => l.end));
  const hourStart = Math.floor(c.start / 60) * 60;
  const zones = new Set(c.legs.map((l) => ledger.room(l.roomId).zone));
  let consolidation = 0;
  let fragmentation = 0;
  for (const z of zones) {
    consolidation += zoneCapacityMinutes(ledger, z, hourStart, Math.max(hourStart + 60, end));
    const before = ledger.longestFreeRun(z);
    const after = ledger.longestFreeRun(z, c.legs);
    fragmentation += Math.min(1, (before - after) / 60);
  }
  consolidation /= zones.size;
  const peak = isPeakMinute(ledger, c.start);
  // Off-peak: pack bookings together. Peak: protect whole free hours (Rotation Hours, parties).
  const wCons = peak ? WEIGHTS.consolidation * 0.5 : WEIGHTS.consolidation;
  const wFrag = peak ? WEIGHTS.fragmentation : WEIGHTS.fragmentation * 0.5;
  const hasPref = req.preferredMin != null;
  const preference = hasPref ? Math.max(0, 1 - Math.abs(c.start - (req.preferredMin as number)) / 80) : 0;
  const steer = !hasPref && !peak ? 1 : 0;
  return wCons * consolidation - wFrag * fragmentation + WEIGHTS.preference * preference + WEIGHTS.steer * steer;
}

export function validate(p: Product | undefined, req: QuoteRequest): string | null {
  if (!p) return "Unknown product";
  if (!p.active) return "This product is not currently on sale";
  if (!Number.isInteger(req.party) || req.party < 1) return "Party size must be at least 1";
  if (req.party < p.minParty) return `${p.name} needs at least ${p.minParty} people`;
  if (req.party > p.maxParty) return `${p.name} takes at most ${p.maxParty} people per booking`;
  if (req.chosenRooms && req.chosenRooms.length > 0 && p.shape === "grid20" && req.chosenRooms.length !== p.legs)
    return `Pick exactly ${p.legs} game${p.legs > 1 ? "s" : ""}`;
  return null;
}

export function quote(ledger: Ledger, p: Product | undefined, req: QuoteRequest): QuoteResult {
  const err = validate(p, req);
  if (err || !p) return { offers: [], error: err ?? "Invalid request" };
  const cands = candidateStarts(ledger, p, req);
  const offers: Offer[] = cands.map((c) => ({
    start: c.start,
    end: Math.max(...c.legs.map((l) => l.end)),
    legs: c.legs,
    blocks: c.blocks,
    peak: isPeakMinute(ledger, c.start),
    pricePaise: priceFor(p, req.party),
    score: Math.round(score(ledger, p, req, c) * 1000) / 1000,
  }));
  offers.sort((a, b) => b.score - a.score || a.start - b.start);
  return { offers: offers.slice(0, req.limit ?? 5) };
}

/** Re-verify an offer against the current ledger (commit-time check under the day lock). */
export function stillFits(ledger: Ledger, p: Product, party: number, legs: Leg[], blocks: Block[] = []): boolean {
  if (p.shape === "party") {
    return legs.every((l) => ledger.empty(l.roomId, l.start, l.end)) && blocks.every((b) => ledger.empty(b.roomId, b.start, b.end));
  }
  if (new Set(legs.filter((l) => ledger.room(l.roomId).zone === "game").map((l) => l.roomId)).size !==
    legs.filter((l) => ledger.room(l.roomId).zone === "game").length) return false;
  for (const l of legs) {
    const room = ledger.room(l.roomId);
    if (!ledger.fits(l.roomId, l.start, l.end, party)) return false;
    if (room.zone === "game") {
      const rot = p.shape === "rotation" && l.end - l.start < 20;
      if (rot && ledger.gridLegs[Math.floor(l.start / 60)] > 0) return false;
      if (!rot && !gridHourOk(ledger, l.start)) return false;
    }
  }
  return true;
}
