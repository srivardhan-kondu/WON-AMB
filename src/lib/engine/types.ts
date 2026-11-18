// Core scheduling types — mirrors §4 of the algorithm design doc.
// All times are minutes from local (IST) midnight of the booking day.

export type Zone = "game" | "splatter";

/** Scheduling shape of a product (§3). */
export type Shape =
  | "grid20" // Choice of 1 / Choice of 3 / Family: N × 20-min legs, distinct rooms, back-to-back
  | "rotation" // All 5 games: 5 × 12-min legs inside a Rotation Hour
  | "splatter" // Neon Room + Day Room together, 60 min, then 15-min cleanup
  | "combo" // Choice-of-3 hour → inter-zone buffer → splatter session
  | "party"; // Exclusive block booking of a whole zone (+ setup/teardown)

export type Channel = "online" | "desk";

export interface Room {
  id: string;
  name: string;
  zone: Zone;
  capacity: number;
  resetMin: number;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  shape: Shape;
  legs: number;
  legMin: number;
  playMin: number;
  pricePaise: number; // per person (pricing = "pp") or per pack of 4 (pricing = "pack4")
  extraPaise: number; // per extra person beyond the pack
  pricing: "pp" | "pack4";
  zone: Zone;
  minParty: number;
  maxParty: number;
  durationMin: number; // for party blocks
  active: boolean;
}

export interface DayConfig {
  day: string; // YYYY-MM-DD
  openMin: number;
  closeMin: number;
  peakHours: number[]; // clock hours that are peak (0–23)
  rotationHours: number[]; // hours pre-flagged as Rotation Hours by the owner
  holdbackPct: number;
  deepCleanStart: number | null;
  deepCleanMin: number;
  deepCleanZone: Zone;
  splatterCadence: number; // 75 = 60 play + 15 cleanup
  /** §3.3: "rotation" = All 5 in one hour (5 × 12 min, Rotation Hours); "grid" = 5 × 20-min legs (100 min) on the normal grid. */
  all5Mode: "rotation" | "grid";
}

export interface Leg {
  roomId: string;
  start: number;
  end: number;
}

/** A booking as the ledger sees it. */
export interface LedgerBooking {
  id: number | string;
  shape: Shape;
  party: number;
  exclusive: boolean;
  legs: Leg[];
}

export interface Block {
  roomId: string;
  start: number;
  end: number;
  reason: string;
}

export interface QuoteRequest {
  productId: string;
  party: number;
  preferredMin?: number | null;
  chosenRooms?: string[] | null;
  channel: Channel;
  /** If set, only starts at/after this minute (walk-ins: window = now). */
  notBefore?: number | null;
  /** Only starts strictly within [windowStart, windowEnd). */
  windowStart?: number | null;
  windowEnd?: number | null;
  /** Minutes-from-midnight "now" if the booking day is today, used by hold-back release. */
  nowMin?: number | null;
  /** Restrict to exactly this start (reschedule / waitlist accept). */
  exactStart?: number | null;
  limit?: number;
}

export interface Offer {
  start: number;
  end: number;
  legs: Leg[];
  score: number;
  peak: boolean;
  pricePaise: number;
  /** Setup/teardown blocks for party bookings. */
  blocks?: Block[];
  /** Set when a flash (dead-slot) price replaced the catalogue price. */
  flash?: boolean;
  basePricePaise?: number;
}

export interface QuoteResult {
  offers: Offer[];
  error?: string;
}
