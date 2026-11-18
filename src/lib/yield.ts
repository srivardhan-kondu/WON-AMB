// Revenue rules on top of feasibility (§8) — they change prices and offerability, never feasibility.
//  • Dead-slot rescue (§8.5): if D-1 game-zone utilization of a weekday-morning hour is under 25%,
//    auto-open a flash price (default Choice-of-3 at ₹799) for that hour only. Never applies at peak.
//  • Member booking horizon (§7): peak-hour member visits bookable only N days ahead.

import { db } from "./db";
import type { Offer, Product } from "./engine";
import { HttpError } from "./http";
import { audit, buildLedger, getDayConfig, getProduct, listRooms } from "./repo";
import { addDays, nowIST } from "./time";

export interface FlashOffer {
  id: number;
  day: string;
  product_id: string;
  start_hour: number;
  end_hour: number;
  price_paise: number;
  min_party: number;
  auto: number;
  created_by: string;
}

export interface YieldSettings {
  flashAuto: boolean;
  flashProduct: string;
  flashPricePaise: number;
  flashThreshold: number;
  flashHours: [number, number]; // "weekday morning" window [start, end)
  memberPeakHorizonDays: number;
  memberOffpeakHorizonDays: number;
}

const YIELD_KEYS: Record<keyof YieldSettings, [string, unknown]> = {
  flashAuto: ["flash_auto", true],
  flashProduct: ["flash_product", "c3"],
  flashPricePaise: ["flash_price_paise", 79900],
  flashThreshold: ["flash_threshold", 0.25],
  flashHours: ["flash_hours", [11, 14]],
  memberPeakHorizonDays: ["member_peak_horizon_days", 2],
  memberOffpeakHorizonDays: ["member_offpeak_horizon_days", 7],
};

export async function yieldSettings(): Promise<YieldSettings> {
  const keys = Object.values(YIELD_KEYS).map(([k]) => k);
  const rows = await db().prepare("SELECT key, value FROM settings WHERE key = ANY(?)").all<{ key: string; value: string }>(keys);
  const stored = new Map(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
  return Object.fromEntries(
    Object.entries(YIELD_KEYS).map(([field, [key, fallback]]) => [field, stored.has(key) ? stored.get(key) : fallback]),
  ) as unknown as YieldSettings;
}

export async function saveYieldSettings(s: YieldSettings) {
  const up = db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [field, [key]] of Object.entries(YIELD_KEYS)) await up.run(key, JSON.stringify(s[field as keyof YieldSettings]));
}

export async function flashOffersFor(day: string): Promise<FlashOffer[]> {
  return db().prepare("SELECT * FROM flash_offers WHERE day = ? ORDER BY start_hour").all<FlashOffer>(day);
}

/** Rewrite offer prices where a flash price applies. Only per-person products, only off-peak hours. */
export async function applyFlash(day: string, product: Product, party: number, offers: Offer[], peakHours: number[]) {
  if (product.pricing !== "pp" || !offers.length) return;
  const flashes = (await flashOffersFor(day)).filter((f) => f.product_id === product.id);
  if (!flashes.length) return;
  for (const o of offers) {
    const h = Math.floor(o.start / 60);
    if (peakHours.includes(h)) continue; // the discount never leaks into peak inventory
    const f = flashes.find((x) => h >= x.start_hour && h < x.end_hour && party >= (x.min_party ?? 1));
    if (!f) continue;
    const price = f.price_paise * party;
    if (price < o.pricePaise) {
      o.basePricePaise = o.pricePaise;
      o.pricePaise = price;
      o.flash = true;
    }
  }
}

/** Game-zone utilization of one clock hour, from the ledger. */
async function hourUtilization(day: string, hour: number): Promise<number> {
  const [ledger, rooms] = await Promise.all([buildLedger(day), listRooms()]);
  let sold = 0;
  let cap = 0;
  for (const r of rooms.filter((x) => x.zone === "game")) {
    for (let m = hour * 60; m < hour * 60 + 60; m++) {
      if (ledger.isBlocked(r.id, m)) continue;
      sold += Math.min(r.capacity, ledger.occAt(r.id, m));
      cap += r.capacity;
    }
  }
  return cap ? sold / cap : 1;
}

/** D-1 check, run once per day by the scheduler: opens flash prices on dead weekday-morning hours. */
export async function autoFlashForTomorrow(): Promise<FlashOffer[]> {
  const s = await yieldSettings();
  if (!s.flashAuto) return [];
  const tomorrow = addDays(nowIST().day, 1);
  const d = db();
  const marker = `flash_checked:${tomorrow}`;
  // Claim the once-per-day check atomically (several instances may tick at once).
  const claimed = await d.prepare("INSERT INTO settings (key, value) VALUES (?, 'true') ON CONFLICT (key) DO NOTHING").run(marker);
  if (!claimed.changes) return [];
  const dow = new Date(`${tomorrow}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return [];
  const cfg = await getDayConfig(tomorrow);
  const product = await getProduct(s.flashProduct);
  if (!product?.active) return [];
  const opened: FlashOffer[] = [];
  for (let h = s.flashHours[0]; h < s.flashHours[1]; h++) {
    if (h * 60 < cfg.openMin || h * 60 + 60 > cfg.closeMin || cfg.peakHours.includes(h)) continue;
    const u = await hourUtilization(tomorrow, h);
    if (u >= s.flashThreshold) continue;
    const info = await d
      .prepare("INSERT INTO flash_offers (day, product_id, start_hour, end_hour, price_paise, auto, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, 'system', ?) ON CONFLICT DO NOTHING RETURNING *")
      .run<FlashOffer>(tomorrow, product.id, h, h + 1, s.flashPricePaise, Date.now());
    if (info.changes) {
      await audit("system", "flash_offer_opened", `${tomorrow}@${h}:00`, { product: product.id, pricePaise: s.flashPricePaise, utilization: Math.round(u * 100) / 100 });
      opened.push(info.rows[0]);
    }
  }
  return opened;
}

/** §7: member bookings only N days ahead for peak hours (₹0-marginal visits must not crowd out sales). */
export async function checkMemberHorizon(day: string, start: number) {
  const [s, cfg] = await Promise.all([yieldSettings(), getDayConfig(day)]);
  const peak = cfg.peakHours.includes(Math.floor(start / 60));
  const horizon = peak ? s.memberPeakHorizonDays : s.memberOffpeakHorizonDays;
  if (day > addDays(nowIST().day, horizon))
    throw new HttpError(400, `Member visits${peak ? " at peak times" : ""} can be booked up to ${horizon} days ahead`);
}
