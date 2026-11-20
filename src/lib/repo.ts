// Data access: catalogue, day config, and rebuilding the engine ledger from the DB.

import { db } from "./db";
import { Ledger, defaultDayConfig, defaultPeakHours, type Block, type DayConfig, type LedgerBooking, type Product, type Room, type Shape, type Zone } from "./engine";

/** Statuses that hold capacity in the ledger. Holds count only until they expire. */
export const LIVE_STATUSES = ["hold", "confirmed", "arrived", "done"] as const;

interface ProductRow {
  id: string; name: string; description: string; shape: Shape; legs: number; leg_min: number; play_min: number;
  price_paise: number; extra_paise: number; pricing: "pp" | "pack4"; zone: Zone; min_party: number; max_party: number;
  duration_min: number; active: number; sort: number;
}

export function rowToProduct(r: ProductRow): Product {
  return {
    id: r.id, name: r.name, description: r.description, shape: r.shape, legs: r.legs, legMin: r.leg_min, playMin: r.play_min,
    pricePaise: r.price_paise, extraPaise: r.extra_paise, pricing: r.pricing, zone: r.zone, minParty: r.min_party,
    maxParty: r.max_party, durationMin: r.duration_min, active: !!r.active,
  };
}

// Rooms are fixed hardware (no API edits them), so each instance caches them briefly.
let roomCache: { at: number; rooms: Room[] } | null = null;

export async function listRooms(): Promise<Room[]> {
  if (roomCache && Date.now() - roomCache.at < 60_000) return roomCache.rooms;
  const rows = await db().prepare("SELECT * FROM rooms ORDER BY sort").all<{ id: string; name: string; zone: Zone; capacity: number; reset_min: number }>();
  const rooms = rows.map((r) => ({ id: r.id, name: r.name, zone: r.zone, capacity: r.capacity, resetMin: r.reset_min }));
  roomCache = { at: Date.now(), rooms };
  return rooms;
}

export async function listProducts(includeInactive = false): Promise<Product[]> {
  const rows = await db().prepare(`SELECT * FROM products ${includeInactive ? "" : "WHERE active = 1"} ORDER BY sort`).all<ProductRow>();
  return rows.map(rowToProduct);
}

/**
 * Product as sold on `day`: the catalogue row with the latest scheduled price whose effective-from
 * date is on or before that day (§7 price editor with effective-from dates). Without a day: today's catalogue row.
 */
export async function getProduct(id: string, day?: string): Promise<Product | undefined> {
  const r = await db().prepare("SELECT * FROM products WHERE id = ?").get<ProductRow>(id);
  if (!r) return undefined;
  const p = rowToProduct(r);
  return day ? priceOn(p, day) : p;
}

export async function priceOn(p: Product, day: string): Promise<Product> {
  const s = await db()
    .prepare("SELECT price_paise, extra_paise FROM price_schedule WHERE product_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1")
    .get<{ price_paise: number; extra_paise: number }>(p.id, day);
  return s ? { ...p, pricePaise: s.price_paise, extraPaise: s.extra_paise } : p;
}

export interface ScheduledPrice { id: number; product_id: string; effective_from: string; price_paise: number; extra_paise: number; created_by: string; created_at: number }

/** Fold scheduled prices whose date has arrived into the catalogue row, so the catalogue always shows today's price. */
export async function applyDuePrices(today: string) {
  const d = db();
  const due = await d
    .prepare(
      `SELECT ps.* FROM price_schedule ps
       WHERE ps.effective_from <= ? AND ps.effective_from = (SELECT MAX(effective_from) FROM price_schedule x WHERE x.product_id = ps.product_id AND x.effective_from <= ?)`,
    )
    .all<ScheduledPrice>(today, today);
  for (const s of due) {
    const r = await d.prepare("UPDATE products SET price_paise = ?, extra_paise = ? WHERE id = ? AND (price_paise != ? OR extra_paise != ?)").run(s.price_paise, s.extra_paise, s.product_id, s.price_paise, s.extra_paise);
    if (r.changes) await audit("system", "scheduled_price_applied", `product:${s.product_id}`, { price: s.price_paise, extra: s.extra_paise, effectiveFrom: s.effective_from });
  }
  // Past schedule rows are now history; keep only the one in force (for lookups of past days) and future ones.
  await d.prepare(
    `DELETE FROM price_schedule WHERE effective_from < ? AND effective_from < (SELECT MAX(effective_from) FROM price_schedule x WHERE x.product_id = price_schedule.product_id AND x.effective_from <= ?)`,
  ).run(today, today);
}

interface DayRow {
  day: string; open_min: number | null; close_min: number | null; peak: number | null; peak_hours: string | null;
  rotation_hours: string; holdback_pct: number | null; deep_clean_start: number | null; deep_clean_min: number | null; deep_clean_zone: Zone | null;
  all5_mode: "rotation" | "grid" | null;
}

/** Venue-wide defaults the owner can change (stored in settings), overridden per day by day_config. */
export async function venueDefaults() {
  const rows = await db().prepare("SELECT key, value FROM settings WHERE key IN ('open_min','close_min','holdback_pct','deep_clean_start','deep_clean_min','deep_clean_zone','all5_mode')").all<{ key: string; value: string }>();
  const s = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return {
    openMin: (s.open_min as number) ?? 660,
    closeMin: (s.close_min as number) ?? 1320,
    holdbackPct: (s.holdback_pct as number) ?? 20,
    deepCleanStart: s.deep_clean_start === undefined ? 990 : (s.deep_clean_start as number | null),
    deepCleanMin: (s.deep_clean_min as number) ?? 30,
    deepCleanZone: ((s.deep_clean_zone as Zone) ?? "game") as Zone,
    all5Mode: ((s.all5_mode as "rotation" | "grid") ?? "rotation") as "rotation" | "grid",
  };
}

export async function getDayConfig(day: string): Promise<DayConfig & { peakOverride: boolean | null; hasOverride: boolean; all5Override: "rotation" | "grid" | null }> {
  const base = defaultDayConfig(day);
  const [v, r] = await Promise.all([venueDefaults(), db().prepare("SELECT * FROM day_config WHERE day = ?").get<DayRow>(day)]);
  const openMin = r?.open_min ?? v.openMin;
  const closeMin = r?.close_min ?? v.closeMin;
  let peakHours = defaultPeakHours(day, openMin, closeMin);
  if (r?.peak_hours) peakHours = JSON.parse(r.peak_hours);
  else if (r?.peak === 1) peakHours = range(Math.floor(openMin / 60), Math.ceil(closeMin / 60));
  else if (r?.peak === 0) peakHours = [];
  return {
    ...base,
    openMin,
    closeMin,
    peakHours,
    rotationHours: r ? JSON.parse(r.rotation_hours) : [],
    holdbackPct: r?.holdback_pct ?? v.holdbackPct,
    deepCleanStart: r && r.deep_clean_min === 0 ? null : (r?.deep_clean_start ?? v.deepCleanStart),
    deepCleanMin: r?.deep_clean_min ?? v.deepCleanMin,
    deepCleanZone: r?.deep_clean_zone ?? v.deepCleanZone,
    all5Mode: r?.all5_mode ?? v.all5Mode,
    all5Override: r?.all5_mode ?? null,
    peakOverride: r?.peak == null ? null : r.peak === 1,
    hasOverride: !!r,
  };
}

function range(a: number, b: number) {
  return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
}

export interface BookingRow {
  id: number; code: string; product_id: string; customer_id: number | null; day: string; start_min: number; end_min: number;
  party_size: number; guest_list: string; status: string; source: string; price_paise: number; deposit_paise: number;
  paid_paise: number; payment_method: string | null; idem_key: string | null; hold_expires: number | null;
  reschedule_count: number; food: number; notes: string; membership_id: number | null; arrived_at: number | null; created_at: number;
  refunded_paise: number;
}
export interface LegRow { booking_id: number; leg_no: number; room_id: string; day: string; start_min: number; end_min: number }

/** Rebuild the capacity ledger for a day from bookings + legs + calendar blocks. */
export async function buildLedger(day: string, opts: { excludeBookingId?: number } = {}): Promise<Ledger> {
  const d = db();
  const t = Date.now();
  const [rows, legs, blockRows, rooms, cfg] = await Promise.all([
    d
      .prepare(
        `SELECT b.id, b.product_id, b.party_size, b.status, b.hold_expires, p.shape
         FROM bookings b JOIN products p ON p.id = b.product_id
         WHERE b.day = ? AND b.status IN ('hold','confirmed','arrived','done')`,
      )
      .all<{ id: number; product_id: string; party_size: number; status: string; hold_expires: number | null; shape: Shape }>(day),
    d.prepare("SELECT * FROM booking_legs WHERE day = ? ORDER BY booking_id, leg_no").all<LegRow>(day),
    d.prepare("SELECT * FROM calendar_blocks WHERE day = ?").all<{ room_id: string; start_min: number; end_min: number; reason: string; booking_id: number | null }>(day),
    listRooms(),
    getDayConfig(day),
  ]);
  const byBooking = new Map<number, LegRow[]>();
  for (const l of legs) {
    const arr = byBooking.get(l.booking_id) ?? [];
    arr.push(l);
    byBooking.set(l.booking_id, arr);
  }
  const bookings: LedgerBooking[] = [];
  const liveIds = new Set<number>();
  for (const r of rows) {
    if (r.id === opts.excludeBookingId) continue;
    if (r.status === "hold" && (r.hold_expires ?? 0) < t) continue; // expiry is a timestamp check
    liveIds.add(r.id);
    bookings.push({
      id: r.id,
      shape: r.shape,
      party: r.party_size,
      exclusive: r.shape === "party",
      legs: (byBooking.get(r.id) ?? []).map((l) => ({ roomId: l.room_id, start: l.start_min, end: l.end_min })),
    });
  }
  const blocks: Block[] = blockRows
    .filter((b) => b.booking_id == null || liveIds.has(b.booking_id))
    .map((b) => ({ roomId: b.room_id, start: b.start_min, end: b.end_min, reason: b.reason }));
  return new Ledger(rooms, cfg, bookings, blocks);
}

export async function getBookingByCode(code: string): Promise<BookingRow | undefined> {
  return db().prepare("SELECT * FROM bookings WHERE code = ?").get<BookingRow>(code.trim().toUpperCase());
}

export async function getLegs(bookingId: number): Promise<LegRow[]> {
  return db().prepare("SELECT * FROM booking_legs WHERE booking_id = ? ORDER BY leg_no").all<LegRow>(bookingId);
}

export async function audit(actor: string, action: string, entity: string, detail: Record<string, unknown> = {}) {
  await db().prepare("INSERT INTO events_audit (actor, action, entity, detail, at) VALUES (?, ?, ?, ?, ?)").run(actor, action, entity, JSON.stringify(detail), Date.now());
}

/** Find-or-create by phone in one statement (safe when two requests for a new number race). */
export async function upsertCustomer(phone: string, name?: string, profile: { age?: number | null; gender?: string | null } = {}): Promise<number> {
  const r = await db()
    .prepare(
      `INSERT INTO customers (phone, name, age, gender, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (phone) DO UPDATE SET
         name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE customers.name END,
         age = COALESCE(EXCLUDED.age, customers.age),
         gender = COALESCE(EXCLUDED.gender, customers.gender)
       RETURNING id`,
    )
    .get<{ id: number }>(phone, name ?? "", profile.age ?? null, profile.gender ?? null, Date.now());
  return r!.id;
}
