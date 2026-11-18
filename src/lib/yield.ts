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

function setting<T>(key: string, fallback: T): T {
  const r = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : fallback;
}

export function yieldSettings() {
  return {
    flashAuto: setting("flash_auto", true),
    flashProduct: setting("flash_product", "c3"),
    flashPricePaise: setting("flash_price_paise", 79900),
    flashThreshold: setting("flash_threshold", 0.25),
    flashHours: setting<[number, number]>("flash_hours", [11, 14]), // "weekday morning" window [start, end)
    memberPeakHorizonDays: setting("member_peak_horizon_days", 2),
    memberOffpeakHorizonDays: setting("member_offpeak_horizon_days", 7),
  };
}

export function saveYieldSettings(s: ReturnType<typeof yieldSettings>) {
  const up = db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  up.run("flash_auto", JSON.stringify(s.flashAuto));
  up.run("flash_product", JSON.stringify(s.flashProduct));
  up.run("flash_price_paise", JSON.stringify(s.flashPricePaise));
  up.run("flash_threshold", JSON.stringify(s.flashThreshold));
  up.run("flash_hours", JSON.stringify(s.flashHours));
  up.run("member_peak_horizon_days", JSON.stringify(s.memberPeakHorizonDays));
  up.run("member_offpeak_horizon_days", JSON.stringify(s.memberOffpeakHorizonDays));
}

export function flashOffersFor(day: string): FlashOffer[] {
  return db().prepare("SELECT * FROM flash_offers WHERE day = ? ORDER BY start_hour").all(day) as FlashOffer[];
}

/** Rewrite offer prices where a flash price applies. Only per-person products, only off-peak hours. */
export function applyFlash(day: string, product: Product, party: number, offers: Offer[], peakHours: number[]) {
  if (product.pricing !== "pp") return;
  const flashes = flashOffersFor(day).filter((f) => f.product_id === product.id);
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
function hourUtilization(day: string, hour: number): number {
  const ledger = buildLedger(day);
  let sold = 0;
  let cap = 0;
  for (const r of listRooms().filter((x) => x.zone === "game")) {
    for (let m = hour * 60; m < hour * 60 + 60; m++) {
      if (ledger.isBlocked(r.id, m)) continue;
      sold += Math.min(r.capacity, ledger.occAt(r.id, m));
      cap += r.capacity;
    }
  }
  return cap ? sold / cap : 1;
}

/** D-1 check, run once per day by the scheduler: opens flash prices on dead weekday-morning hours. */
export function autoFlashForTomorrow(): FlashOffer[] {
  const s = yieldSettings();
  if (!s.flashAuto) return [];
  const tomorrow = addDays(nowIST().day, 1);
  const d = db();
  const marker = `flash_checked:${tomorrow}`;
  if (d.prepare("SELECT 1 FROM settings WHERE key = ?").get(marker)) return [];
  d.prepare("INSERT INTO settings (key, value) VALUES (?, 'true')").run(marker);
  const dow = new Date(`${tomorrow}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return [];
  const cfg = getDayConfig(tomorrow);
  const product = getProduct(s.flashProduct);
  if (!product?.active) return [];
  const opened: FlashOffer[] = [];
  for (let h = s.flashHours[0]; h < s.flashHours[1]; h++) {
    if (h * 60 < cfg.openMin || h * 60 + 60 > cfg.closeMin || cfg.peakHours.includes(h)) continue;
    const u = hourUtilization(tomorrow, h);
    if (u >= s.flashThreshold) continue;
    const info = d
      .prepare("INSERT OR IGNORE INTO flash_offers (day, product_id, start_hour, end_hour, price_paise, auto, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, 'system', ?)")
      .run(tomorrow, product.id, h, h + 1, s.flashPricePaise, Date.now());
    if (info.changes) {
      audit("system", "flash_offer_opened", `${tomorrow}@${h}:00`, { product: product.id, pricePaise: s.flashPricePaise, utilization: Math.round(u * 100) / 100 });
      opened.push(d.prepare("SELECT * FROM flash_offers WHERE id = ?").get(info.lastInsertRowid) as FlashOffer);
    }
  }
  return opened;
}

/** §7: member bookings only N days ahead for peak hours (₹0-marginal visits must not crowd out sales). */
export function checkMemberHorizon(day: string, start: number) {
  const s = yieldSettings();
  const cfg = getDayConfig(day);
  const peak = cfg.peakHours.includes(Math.floor(start / 60));
  const horizon = peak ? s.memberPeakHorizonDays : s.memberOffpeakHorizonDays;
  if (day > addDays(nowIST().day, horizon))
    throw new HttpError(400, `Member visits${peak ? " at peak times" : ""} can be booked up to ${horizon} days ahead`);
}
