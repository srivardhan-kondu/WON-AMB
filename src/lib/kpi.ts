// §12 KPIs — all computed from the ledger and bookings, no extra instrumentation.

import { db } from "./db";
import { buildLedger, listProducts, listRooms } from "./repo";
import { addDays } from "./time";

const SOLD = "('confirmed','arrived','done','no_show')";

export interface WeekKpis {
  weekStart: string;
  revenuePaise: number;
  bookings: number;
  guests: number;
  utilization: { game: number; splatter: number };
  revpashPaise: number;
  noShowRate: number;
  walkInShare: number;
  /** §12: hold-back seat-minutes sold / held back (peak game-zone hours). null when nothing was held back. */
  walkInConversion: number | null;
  holdbackSeatHours: number;
  /** §12: quote rejections where capacity existed but no assignment — must stay 0 by construction. */
  rejections: number;
  falseSellouts: number;
  falseSelloutRate: number;
  refundsPaise: number;
  partyLeadDays: number | null;
  byProduct: { id: string; name: string; bookings: number; guests: number; revenuePaise: number }[];
  hourly: { hour: number; game: number; splatter: number }[];
  daily: { day: string; revenuePaise: number; bookings: number }[];
}

export function weekKpis(weekStart: string): WeekKpis {
  const d = db();
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const end = addDays(weekStart, 7);
  const rooms = listRooms();
  const products = listProducts(true);

  const rows = d
    .prepare(`SELECT product_id, status, source, party_size, price_paise, refunded_paise, day, created_at, start_min FROM bookings WHERE day >= ? AND day < ? AND status IN ${SOLD}`)
    .all(weekStart, end) as { product_id: string; status: string; source: string; party_size: number; price_paise: number; refunded_paise: number; day: string; created_at: number; start_min: number }[];

  const refunds = rows.reduce((s, r) => s + r.refunded_paise, 0);
  const revenue = rows.reduce((s, r) => s + r.price_paise, 0) - refunds;
  const guests = rows.reduce((s, r) => s + r.party_size, 0);
  const noShows = rows.filter((r) => r.status === "no_show").length;
  const walkIns = rows.filter((r) => r.source === "desk").length;

  // Utilization and seat-hours from the ledger, per zone per hour.
  const sold = { game: 0, splatter: 0 } as Record<string, number>;
  const sellable = { game: 0, splatter: 0 } as Record<string, number>;
  const hourSold = new Map<string, number>();
  const hourSellable = new Map<string, number>();
  let seatMinutes = 0;
  let heldBack = 0;
  let heldBackSold = 0;
  for (const day of days) {
    const ledger = buildLedger(day);
    const { openMin, closeMin } = ledger.cfg;
    for (const r of rooms) {
      const hold = r.zone === "game" ? Math.floor((r.capacity * ledger.cfg.holdbackPct) / 100) : 0;
      for (let m = openMin; m < closeMin; m++) {
        if (ledger.isBlocked(r.id, m)) continue;
        const occ = Math.min(r.capacity, ledger.occAt(r.id, m));
        if (hold > 0 && ledger.cfg.peakHours.includes(Math.floor(m / 60))) {
          // Seats above the online ceiling can only have been sold at the desk or after the 2 h release.
          heldBack += hold;
          heldBackSold += Math.max(0, occ - (r.capacity - hold));
        }
        sold[r.zone] += occ;
        sellable[r.zone] += r.capacity;
        seatMinutes += r.capacity;
        const k = `${r.zone}:${Math.floor(m / 60)}`;
        hourSold.set(k, (hourSold.get(k) ?? 0) + occ);
        hourSellable.set(k, (hourSellable.get(k) ?? 0) + r.capacity);
      }
    }
  }
  const hours = Array.from(new Set([...hourSellable.keys()].map((k) => Number(k.split(":")[1])))).sort((a, b) => a - b);

  const parties = rows.filter((r) => products.find((p) => p.id === r.product_id)?.shape === "party");
  const partyLead = parties.length
    ? parties.reduce((s, r) => s + (Date.parse(`${r.day}T00:00:00Z`) + r.start_min * 60_000 - r.created_at) / 86_400_000, 0) / parties.length
    : null;

  return {
    weekStart,
    revenuePaise: revenue,
    bookings: rows.length,
    guests,
    utilization: {
      game: sellable.game ? sold.game / sellable.game : 0,
      splatter: sellable.splatter ? sold.splatter / sellable.splatter : 0,
    },
    revpashPaise: seatMinutes ? Math.round(revenue / (seatMinutes / 60)) : 0,
    noShowRate: rows.length ? noShows / rows.length : 0,
    walkInShare: rows.length ? walkIns / rows.length : 0,
    walkInConversion: heldBack ? heldBackSold / heldBack : null,
    holdbackSeatHours: Math.round(heldBack / 60),
    ...rejectionStats(weekStart, end),
    refundsPaise: refunds,
    partyLeadDays: partyLead == null ? null : Math.round(partyLead * 10) / 10,
    byProduct: products
      .map((p) => {
        const rs = rows.filter((r) => r.product_id === p.id);
        return { id: p.id, name: p.name, bookings: rs.length, guests: rs.reduce((s, r) => s + r.party_size, 0), revenuePaise: rs.reduce((s, r) => s + r.price_paise, 0) };
      })
      .filter((x) => x.bookings > 0),
    hourly: hours.map((h) => ({
      hour: h,
      game: (hourSold.get(`game:${h}`) ?? 0) / (hourSellable.get(`game:${h}`) || 1),
      splatter: (hourSold.get(`splatter:${h}`) ?? 0) / (hourSellable.get(`splatter:${h}`) || 1),
    })),
    daily: days.map((day) => {
      const rs = rows.filter((r) => r.day === day);
      return { day, revenuePaise: rs.reduce((s, r) => s + r.price_paise, 0), bookings: rs.length };
    }),
  };
}

function rejectionStats(from: string, to: string) {
  const r = db()
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(false_sellout), 0) AS f FROM quote_rejections WHERE day >= ? AND day < ?")
    .get(from, to) as { n: number; f: number };
  return { rejections: r.n, falseSellouts: r.f, falseSelloutRate: r.n ? r.f / r.n : 0 };
}
