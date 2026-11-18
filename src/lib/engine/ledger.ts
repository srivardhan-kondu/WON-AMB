// §3.1 The atomic ledger: occ[room][minute] = booked headcount.
// Everything (slots, rotations, cleanups, party holds) compiles down to intervals here,
// so this is the single place where double-booking could happen.

import type { Block, DayConfig, LedgerBooking, Leg, Room } from "./types";

export const DAY_MINUTES = 1440;

export class Ledger {
  readonly rooms: Map<string, Room>;
  readonly cfg: DayConfig;
  private occ = new Map<string, Int16Array>();
  private blocked = new Map<string, Uint8Array>();
  /** Per clock hour: number of rotation (12-min) legs / grid (20-min) legs in game rooms. */
  readonly rotLegs = new Int16Array(24);
  readonly gridLegs = new Int16Array(24);
  readonly blocks: Block[] = [];

  constructor(rooms: Room[], cfg: DayConfig, bookings: LedgerBooking[] = [], blocks: Block[] = []) {
    this.rooms = new Map(rooms.map((r) => [r.id, r]));
    this.cfg = cfg;
    for (const r of rooms) {
      this.occ.set(r.id, new Int16Array(DAY_MINUTES));
      this.blocked.set(r.id, new Uint8Array(DAY_MINUTES));
    }
    for (const b of builtInBlocks(rooms, cfg)) this.addBlock(b);
    for (const b of blocks) this.addBlock(b);
    for (const b of bookings) this.add(b);
  }

  room(id: string): Room {
    const r = this.rooms.get(id);
    if (!r) throw new Error(`unknown room ${id}`);
    return r;
  }

  roomsInZone(zone: string): Room[] {
    return [...this.rooms.values()].filter((r) => r.zone === zone);
  }

  addBlock(b: Block) {
    const arr = this.blocked.get(b.roomId);
    if (!arr) return;
    for (let m = clamp(b.start); m < clamp(b.end); m++) arr[m] = 1;
    this.blocks.push(b);
  }

  add(b: LedgerBooking) {
    for (const leg of b.legs) {
      const arr = this.occ.get(leg.roomId);
      if (!arr) continue;
      const room = this.room(leg.roomId);
      const n = b.exclusive ? room.capacity : b.party;
      for (let m = clamp(leg.start); m < clamp(leg.end); m++) arr[m] += n;
      if (room.zone === "game") {
        const h = Math.floor(leg.start / 60);
        // A 12-min leg is a Rotation-Hour leg; anything on the 20-min grid (incl. All 5 sold as 5 × 20) is grid.
        if (b.shape === "rotation" && leg.end - leg.start < 20) this.rotLegs[h]++;
        else if (b.shape === "grid20" || b.shape === "combo" || b.shape === "rotation") this.gridLegs[h]++;
      }
    }
  }

  /** fits(room, interval, n): all(occ[m] + n <= cap) and nothing blocked. */
  fits(roomId: string, start: number, end: number, n: number, cap?: number): boolean {
    const arr = this.occ.get(roomId);
    const blk = this.blocked.get(roomId);
    if (!arr || !blk) return false;
    const c = cap ?? this.room(roomId).capacity;
    if (start < 0 || end > DAY_MINUTES) return false;
    for (let m = start; m < end; m++) {
      if (blk[m] || arr[m] + n > c) return false;
    }
    return true;
  }

  /** Exclusive fit: room completely empty and unblocked. */
  empty(roomId: string, start: number, end: number): boolean {
    const arr = this.occ.get(roomId);
    const blk = this.blocked.get(roomId);
    if (!arr || !blk) return false;
    for (let m = Math.max(0, start); m < Math.min(DAY_MINUTES, end); m++) {
      if (blk[m] || arr[m] > 0) return false;
    }
    return true;
  }

  occAt(roomId: string, m: number): number {
    return this.occ.get(roomId)?.[m] ?? 0;
  }

  isBlocked(roomId: string, m: number): boolean {
    return (this.blocked.get(roomId)?.[m] ?? 0) === 1;
  }

  /** Guest-minutes booked in a room over [start, end). */
  load(roomId: string, start = 0, end = DAY_MINUTES): number {
    const arr = this.occ.get(roomId);
    if (!arr) return 0;
    let s = 0;
    for (let m = start; m < end; m++) s += arr[m];
    return s;
  }

  /** Longest run of minutes in [open, close) where every room in the zone is empty & unblocked. */
  longestFreeRun(zone: string, extra?: Leg[]): number {
    const rooms = this.roomsInZone(zone);
    let best = 0;
    let cur = 0;
    for (let m = this.cfg.openMin; m < this.cfg.closeMin; m++) {
      let free = true;
      for (const r of rooms) {
        if (this.occAt(r.id, m) > 0 || this.isBlocked(r.id, m)) {
          free = false;
          break;
        }
      }
      if (free && extra) {
        for (const l of extra) {
          if (m >= l.start && m < l.end && rooms.some((r) => r.id === l.roomId)) {
            free = false;
            break;
          }
        }
      }
      cur = free ? cur + 1 : 0;
      if (cur > best) best = cur;
    }
    return best;
  }

  /** Hours where 12-min rotation legs and 20-min grid legs both landed — must never happen (§3.3). */
  mixedCadenceHours(): number[] {
    const out: number[] = [];
    for (let h = 0; h < 24; h++) if (this.rotLegs[h] > 0 && this.gridLegs[h] > 0) out.push(h);
    return out;
  }

  /** Verify capacity invariant over the whole day (used by self-checks). */
  overCapacity(): string[] {
    const errs: string[] = [];
    for (const [id, arr] of this.occ) {
      const cap = this.room(id).capacity;
      for (let m = 0; m < DAY_MINUTES; m++) {
        if (arr[m] > cap) {
          errs.push(`${id} over capacity at minute ${m}: ${arr[m]}/${cap}`);
          break;
        }
      }
    }
    return errs;
  }
}

function clamp(m: number) {
  return Math.max(0, Math.min(DAY_MINUTES, m));
}

/** Splatter session starts for the day: open + k × cadence while the 60-min session fits. */
export function splatterStarts(cfg: DayConfig): number[] {
  const out: number[] = [];
  for (let s = cfg.openMin; s + 60 <= cfg.closeMin; s += cfg.splatterCadence) out.push(s);
  return out;
}

/** Buffers that are part of the day itself (§6): paint cleanup after every session, daily deep clean. */
export function builtInBlocks(rooms: Room[], cfg: DayConfig): Block[] {
  const out: Block[] = [];
  const splat = rooms.filter((r) => r.zone === "splatter");
  for (const s of splatterStarts(cfg)) {
    for (const r of splat) out.push({ roomId: r.id, start: s + 60, end: s + cfg.splatterCadence, reason: "Paint cleanup" });
  }
  if (cfg.deepCleanStart != null && cfg.deepCleanMin > 0) {
    for (const r of rooms.filter((x) => x.zone === cfg.deepCleanZone)) {
      out.push({ roomId: r.id, start: cfg.deepCleanStart, end: cfg.deepCleanStart + cfg.deepCleanMin, reason: "Deep clean" });
    }
  }
  return out;
}
