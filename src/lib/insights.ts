// Owner insights — one pass over bookings, legs and customers for a date range, compared with the
// equal-length period before it. Money in paise; days are IST calendar days ("YYYY-MM-DD").
// Revenue follows the §12 KPI convention: sold bookings (confirmed/arrived/done/no-show) at their
// visit day, net of refunds.

import { db } from "./db";
import { listProducts, listRooms, venueDefaults } from "./repo";
import { addDays, istToEpoch, nowIST, todayIST, weekStart } from "./time";

const SOLD = ["confirmed", "arrived", "done", "no_show"];
const OCCUPYING = "('confirmed','arrived','done')";
const LAPSED_DAYS = 45;

export const RANGES = ["7d", "30d", "90d", "12m", "mtd"] as const;
export type RangeKey = (typeof RANGES)[number];

type Grain = "day" | "week" | "month";

export interface Recommendation {
  tone: "good" | "warning" | "opportunity";
  title: string;
  detail: string;
  action?: { label: string; href: string };
}

export interface Insights {
  range: { key: RangeKey; from: string; to: string; prevFrom: string; days: number; grain: Grain; today: string };
  headline: Record<
    "revenue" | "bookings" | "guests" | "aov" | "perGuest" | "customers" | "newCustomers" | "repeatRate" | "utilization" | "noShowRate" | "cancelRate" | "refunds",
    { cur: number; prev: number }
  >;
  retention: number | null;
  trend: { key: string; label: string; revenue: number; prevRevenue: number | null; bookings: number; guests: number; newCustomers: number; returning: number }[];
  products: { id: string; name: string; revenue: number; prevRevenue: number; bookings: number; guests: number; share: number }[];
  channels: { id: string; revenue: number; bookings: number; prevRevenue: number }[];
  payments: { id: string; revenue: number; bookings: number }[];
  weekdays: { dow: number; avgRevenue: number; avgGuests: number; days: number }[];
  heatmap: { hours: number[]; cells: { dow: number; hour: number; util: number | null }[] };
  zones: { game: { cur: number; prev: number }; splatter: { cur: number; prev: number } };
  leadTime: { label: string; bookings: number }[];
  partySize: { label: string; bookings: number }[];
  demographics: { known: number; total: number; age: { label: string; n: number }[]; gender: { id: string; n: number }[] };
  leakage: {
    noShows: number; noShowValue: number; cancellations: number; cancelValue: number;
    abandoned: number; abandonedValue: number; onlineConversion: number | null; refunds: number;
    soldOutSearches: number; waitlisted: number; waitlistConverted: number;
  };
  memberships: { active: number; expiring30: number; newInPeriod: number; visitsInPeriod: number; plans: { plan: string; active: number }[] };
  topCustomers: Customer[];
  winBack: Customer[];
  forward: { days: { day: string; bookings: number; guests: number; revenue: number }[]; revenue: number; bookings: number; guests: number };
  recommendations: Recommendation[];
}

interface Customer { id: number; name: string; phone: string; visits: number; lifetimeVisits: number; spend: number; lifetimeSpend: number; lastVisit: string }

interface Row {
  id: number; product_id: string; customer_id: number | null; day: string; start_min: number; party_size: number;
  status: string; source: string; price_paise: number; refunded_paise: number; payment_method: string | null; created_at: number;
}

export function resolveRange(key: RangeKey, today = todayIST()) {
  const to = addDays(today, 1);
  let from: string;
  if (key === "mtd") from = today.slice(0, 8) + "01";
  else if (key === "12m") from = addDays(to, -365);
  else from = addDays(to, -Number(key.replace("d", "")));
  const days = daysBetween(from, to);
  const grain: Grain = days <= 31 ? "day" : days <= 120 ? "week" : "month";
  return { key, from, to, prevFrom: addDays(from, -days), days, grain, today };
}

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
function eachDay(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}
const dowOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Mon
const ratio = (a: number, b: number) => (b ? a / b : 0);
const net = (r: Row) => r.price_paise - r.refunded_paise;
const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

function group(xs: Row[], f: (r: Row) => string) {
  const m = new Map<string, Row[]>();
  for (const r of xs) {
    const k = f(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

function bucketKey(day: string, grain: Grain) {
  return grain === "day" ? day : grain === "week" ? weekStart(day) : day.slice(0, 7);
}
function bucketLabel(key: string, grain: Grain) {
  const d = new Date(`${grain === "month" ? key + "-01" : key}T00:00:00Z`);
  if (grain === "month") return d.toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

export async function buildInsights(key: RangeKey): Promise<Insights> {
  const R = resolveRange(key);
  const { from, to, prevFrom, grain, today } = R;
  const d = db();

  const [rooms, products, defaults, dayRows, rows, legs, lifetime, rejections, waitlist, memberships, memberVisits, forwardRows, firstRow] = await Promise.all([
    listRooms(),
    listProducts(true),
    venueDefaults(),
    d.prepare("SELECT day, open_min, close_min FROM day_config WHERE day >= ? AND day < ?").all<{ day: string; open_min: number | null; close_min: number | null }>(prevFrom, to),
    d
      .prepare(
        `SELECT id, product_id, customer_id, day, start_min, party_size, status, source, price_paise, refunded_paise, payment_method, created_at
         FROM bookings WHERE day >= ? AND day < ?`,
      )
      .all<Row>(prevFrom, to),
    d
      .prepare(
        `SELECT l.room_id, l.day, l.start_min, l.end_min, b.party_size, p.shape
         FROM booking_legs l JOIN bookings b ON b.id = l.booking_id JOIN products p ON p.id = b.product_id
         WHERE l.day >= ? AND l.day < ? AND b.status IN ${OCCUPYING}`,
      )
      .all<{ room_id: string; day: string; start_min: number; end_min: number; party_size: number; shape: string }>(prevFrom, to),
    // Lifetime stats per customer up to the end of the range (drives new vs returning and win-back).
    d
      .prepare(
        `SELECT b.customer_id AS id, c.name, c.phone, MIN(b.day) AS first_day, MAX(b.day) AS last_day,
                COUNT(*) AS visits, SUM(b.price_paise - b.refunded_paise) AS spend
         FROM bookings b JOIN customers c ON c.id = b.customer_id
         WHERE b.status IN ('confirmed','arrived','done','no_show') AND b.day < ?
         GROUP BY b.customer_id, c.name, c.phone`,
      )
      .all<{ id: number; name: string; phone: string; first_day: string; last_day: string; visits: number; spend: number }>(to),
    d.prepare("SELECT COUNT(*) AS n FROM quote_rejections WHERE day >= ? AND day < ?").get<{ n: number }>(from, to),
    d.prepare("SELECT state, COUNT(*) AS n FROM waitlist WHERE day >= ? AND day < ? GROUP BY state").all<{ state: string; n: number }>(from, to),
    d.prepare("SELECT plan, valid_till, created_at FROM memberships").all<{ plan: string; valid_till: string; created_at: number }>(),
    d.prepare("SELECT COUNT(*) AS n FROM membership_visits WHERE used_at >= ? AND used_at < ?").get<{ n: number }>(istToEpoch(from, 0), istToEpoch(to, 0)),
    d
      .prepare(
        `SELECT day, COUNT(*) AS bookings, SUM(party_size) AS guests, SUM(price_paise - refunded_paise) AS revenue
         FROM bookings WHERE day >= ? AND day < ? AND status IN ('confirmed','arrived','done') GROUP BY day`,
      )
      .all<{ day: string; bookings: number; guests: number; revenue: number }>(today, addDays(today, 14)),
    d.prepare("SELECT MIN(day) AS day FROM bookings WHERE status IN ('confirmed','arrived','done','no_show')").get<{ day: string | null }>(),
  ]);
  // Days before the first ever sale don't count as open capacity (the venue wasn't trading yet).
  const firstDay = firstRow?.day ?? today;
  const trading = (day: string) => day >= firstDay && day <= today;

  const inCur = (r: { day: string }) => r.day >= from;
  const cur = rows.filter(inCur);
  const prev = rows.filter((r) => !inCur(r));
  const sold = (xs: Row[]) => xs.filter((r) => SOLD.includes(r.status));
  const curSold = sold(cur);
  const prevSold = sold(prev);
  const productName = new Map(products.map((p) => [p.id, p.name]));
  const life = new Map(lifetime.map((c) => [c.id, c]));

  // --- Customers -----------------------------------------------------------------------------
  const customerStats = (xs: Row[], start: string) => {
    const count = new Map<number, number>();
    for (const r of xs) if (r.customer_id != null) count.set(r.customer_id, (count.get(r.customer_id) ?? 0) + 1);
    const ids = new Set(count.keys());
    let fresh = 0;
    let repeat = 0;
    for (const [id, n] of count) {
      const l = life.get(id);
      if (!l) continue;
      if (l.first_day >= start) fresh++;
      // Returning = visited before this period, or more than once within it.
      if (l.first_day < start || n > 1) repeat++;
    }
    return { ids, fresh, repeat };
  };
  const cc = customerStats(curSold, from);
  const pc = customerStats(prevSold, prevFrom);
  const retained = [...pc.ids].filter((id) => cc.ids.has(id)).length;

  // --- Utilisation (seat-minutes sold / seat-minutes open) ------------------------------------
  const cfgByDay = new Map(dayRows.map((r) => [r.day, r]));
  const hoursOf = (day: string) => {
    const r = cfgByDay.get(day);
    return { open: r?.open_min ?? defaults.openMin, close: r?.close_min ?? defaults.closeMin };
  };
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const zoneCap = { game: 0, splatter: 0 } as Record<string, number>;
  for (const r of rooms) zoneCap[r.zone] += r.capacity;
  const totalCap = zoneCap.game + zoneCap.splatter;

  const usedZone = { cur: { game: 0, splatter: 0 }, prev: { game: 0, splatter: 0 } } as Record<"cur" | "prev", Record<string, number>>;
  const openZone = { cur: { game: 0, splatter: 0 }, prev: { game: 0, splatter: 0 } } as Record<"cur" | "prev", Record<string, number>>;
  const heatUsed = new Map<string, number>();
  const heatOpen = new Map<string, number>();
  const hourSet = new Set<number>();

  for (const day of eachDay(prevFrom, to)) {
    if (!trading(day)) continue;
    const p = day >= from ? "cur" : "prev";
    const { open, close } = hoursOf(day);
    const mins = Math.max(0, close - open);
    openZone[p].game += zoneCap.game * mins;
    openZone[p].splatter += zoneCap.splatter * mins;
    if (p === "cur") {
      for (let h = Math.floor(open / 60); h * 60 < close; h++) {
        const m = Math.min(close, (h + 1) * 60) - Math.max(open, h * 60);
        const k = `${dowOf(day)}:${h}`;
        heatOpen.set(k, (heatOpen.get(k) ?? 0) + m * totalCap);
        hourSet.add(h);
      }
    }
  }
  for (const l of legs) {
    const room = roomById.get(l.room_id);
    if (!room) continue;
    const occ = l.shape === "party" ? room.capacity : Math.min(l.party_size, room.capacity);
    const p = l.day >= from ? "cur" : "prev";
    usedZone[p][room.zone] += occ * (l.end_min - l.start_min);
    if (p === "cur") {
      for (let h = Math.floor(l.start_min / 60); h * 60 < l.end_min; h++) {
        const m = Math.min(l.end_min, (h + 1) * 60) - Math.max(l.start_min, h * 60);
        const k = `${dowOf(l.day)}:${h}`;
        heatUsed.set(k, (heatUsed.get(k) ?? 0) + occ * m);
      }
    }
  }
  const util = (p: "cur" | "prev", z?: string) =>
    z ? ratio(usedZone[p][z], openZone[p][z]) : ratio(usedZone[p].game + usedZone[p].splatter, openZone[p].game + openZone[p].splatter);
  const hours = [...hourSet].sort((a, b) => a - b);
  const heatCells = [];
  for (let dow = 0; dow < 7; dow++) {
    for (const hour of hours) {
      const open = heatOpen.get(`${dow}:${hour}`) ?? 0;
      heatCells.push({ dow, hour, util: open ? Math.min(1, (heatUsed.get(`${dow}:${hour}`) ?? 0) / open) : null });
    }
  }

  // --- Headline --------------------------------------------------------------------------------
  const head = (xs: Row[], all: Row[], c: { ids: Set<number>; fresh: number; repeat: number }, p: "cur" | "prev") => {
    const revenue = sum(xs, net);
    const guests = sum(xs, (r) => r.party_size);
    return {
      revenue,
      bookings: xs.length,
      guests,
      aov: Math.round(ratio(revenue, xs.length)),
      perGuest: Math.round(ratio(revenue, guests)),
      customers: c.ids.size,
      newCustomers: c.fresh,
      repeatRate: ratio(c.repeat, c.ids.size),
      utilization: util(p),
      noShowRate: ratio(xs.filter((r) => r.status === "no_show").length, xs.length),
      cancelRate: ratio(all.filter((r) => r.status === "cancelled").length, xs.length + all.filter((r) => r.status === "cancelled").length),
      refunds: sum(xs, (r) => r.refunded_paise),
    };
  };
  const hc = head(curSold, cur, cc, "cur");
  const hp = head(prevSold, prev, pc, "prev");
  const headline = Object.fromEntries(Object.keys(hc).map((k) => [k, { cur: hc[k as keyof typeof hc], prev: hp[k as keyof typeof hp] }])) as Insights["headline"];

  // --- Trend -----------------------------------------------------------------------------------
  const curKeys = [...new Set(eachDay(from, to).map((x) => bucketKey(x, grain)))];
  const prevKeys = [...new Set(eachDay(prevFrom, from).map((x) => bucketKey(x, grain)))];
  const curB = group(curSold, (r) => bucketKey(r.day, grain));
  const prevB = group(prevSold, (r) => bucketKey(r.day, grain));
  // Align the previous period from its end so the latest buckets line up.
  const offset = prevKeys.length - curKeys.length;
  const trend = curKeys.map((k, i) => {
    const xs = curB.get(k) ?? [];
    const pk = prevKeys[i + offset];
    const ids = new Set(xs.map((r) => r.customer_id).filter((x): x is number => x != null));
    let newCustomers = 0;
    for (const id of ids) if ((life.get(id)?.first_day ?? "") >= (grain === "month" ? k + "-01" : k)) newCustomers++;
    return {
      key: k,
      label: bucketLabel(k, grain),
      revenue: sum(xs, net),
      prevRevenue: pk ? sum(prevB.get(pk) ?? [], net) : null,
      bookings: xs.length,
      guests: sum(xs, (r) => r.party_size),
      newCustomers,
      returning: ids.size - newCustomers,
    };
  });

  // --- Mix -------------------------------------------------------------------------------------
  const prodCur = group(curSold, (r) => r.product_id);
  const prodPrev = group(prevSold, (r) => r.product_id);
  const productsOut = [...new Set([...prodCur.keys(), ...prodPrev.keys()])]
    .map((id) => {
      const xs = prodCur.get(id) ?? [];
      return { id, name: productName.get(id) ?? id, revenue: sum(xs, net), prevRevenue: sum(prodPrev.get(id) ?? [], net), bookings: xs.length, guests: sum(xs, (r) => r.party_size), share: ratio(sum(xs, net), hc.revenue) };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const chCur = group(curSold, (r) => r.source);
  const chPrev = group(prevSold, (r) => r.source);
  const channels = ["online", "desk", "phone"].map((id) => ({ id, revenue: sum(chCur.get(id) ?? [], net), bookings: (chCur.get(id) ?? []).length, prevRevenue: sum(chPrev.get(id) ?? [], net) }));

  const payments = [...group(curSold, (r) => r.payment_method ?? "unrecorded")]
    .map(([id, xs]) => ({ id, revenue: sum(xs, net), bookings: xs.length }))
    .sort((a, b) => b.revenue - a.revenue);

  const dayCount = new Array(7).fill(0);
  for (const x of eachDay(from, to)) if (trading(x)) dayCount[dowOf(x)]++;
  const weekdays = Array.from({ length: 7 }, (_, dow) => {
    const xs = curSold.filter((r) => dowOf(r.day) === dow);
    return { dow, days: dayCount[dow], avgRevenue: Math.round(ratio(sum(xs, net), dayCount[dow])), avgGuests: Math.round(ratio(sum(xs, (r) => r.party_size), dayCount[dow]) * 10) / 10 };
  });

  // --- Behaviour -------------------------------------------------------------------------------
  const LEAD = [
    { label: "Same day", max: 0 },
    { label: "1 day ahead", max: 1 },
    { label: "2–3 days", max: 3 },
    { label: "4–7 days", max: 7 },
    { label: "8–14 days", max: 14 },
    { label: "15+ days", max: Infinity },
  ];
  const leadTime = LEAD.map((b) => ({ label: b.label, bookings: 0 }));
  for (const r of curSold) {
    const lead = daysBetween(nowIST(r.created_at).day, r.day);
    leadTime[LEAD.findIndex((b) => lead <= b.max)].bookings++;
  }
  const PARTY = [
    { label: "Solo", max: 1 },
    { label: "2", max: 2 },
    { label: "3–4", max: 4 },
    { label: "5–6", max: 6 },
    { label: "7–12", max: 12 },
    { label: "13+", max: Infinity },
  ];
  const partySize = PARTY.map((b) => ({ label: b.label, bookings: 0 }));
  for (const r of curSold) partySize[PARTY.findIndex((b) => r.party_size <= b.max)].bookings++;

  const ids = [...cc.ids];
  const profiles = ids.length
    ? await d.prepare("SELECT age, gender FROM customers WHERE id = ANY(?::bigint[])").all<{ age: number | null; gender: string | null }>(ids)
    : [];
  const AGES = [
    { label: "Under 13", max: 12 },
    { label: "13–17", max: 17 },
    { label: "18–24", max: 24 },
    { label: "25–34", max: 34 },
    { label: "35–44", max: 44 },
    { label: "45+", max: Infinity },
  ];
  const age = AGES.map((a) => ({ label: a.label, n: 0 }));
  const gender = new Map<string, number>();
  let known = 0;
  for (const p of profiles) {
    if (p.age != null || p.gender) known++;
    if (p.age != null) age[AGES.findIndex((a) => p.age! <= a.max)].n++;
    if (p.gender) gender.set(p.gender, (gender.get(p.gender) ?? 0) + 1);
  }

  // --- Leakage ---------------------------------------------------------------------------------
  const noShows = curSold.filter((r) => r.status === "no_show");
  const cancels = cur.filter((r) => r.status === "cancelled");
  const abandoned = cur.filter((r) => r.status === "expired");
  const onlineSold = curSold.filter((r) => r.source === "online").length;
  const onlineAbandoned = abandoned.filter((r) => r.source === "online").length;
  const wl = new Map(waitlist.map((w) => [w.state, w.n]));
  const leakage = {
    noShows: noShows.length,
    noShowValue: sum(noShows, (r) => r.price_paise),
    cancellations: cancels.length,
    cancelValue: sum(cancels, (r) => r.price_paise),
    abandoned: abandoned.length,
    abandonedValue: sum(abandoned, (r) => r.price_paise),
    onlineConversion: onlineSold + onlineAbandoned ? onlineSold / (onlineSold + onlineAbandoned) : null,
    refunds: hc.refunds,
    soldOutSearches: rejections?.n ?? 0,
    waitlisted: sum(waitlist, (w) => w.n),
    waitlistConverted: wl.get("accepted") ?? 0,
  };

  // --- Memberships -----------------------------------------------------------------------------
  const active = memberships.filter((m) => m.valid_till >= today);
  const planCount = new Map<string, number>();
  for (const m of active) planCount.set(m.plan, (planCount.get(m.plan) ?? 0) + 1);
  const fromMs = istToEpoch(from, 0);
  const membershipsOut = {
    active: active.length,
    expiring30: active.filter((m) => m.valid_till <= addDays(today, 30)).length,
    newInPeriod: memberships.filter((m) => m.created_at >= fromMs).length,
    visitsInPeriod: memberVisits?.n ?? 0,
    plans: [...planCount].map(([plan, n]) => ({ plan, active: n })).sort((a, b) => b.active - a.active),
  };

  // --- Customer lists --------------------------------------------------------------------------
  const spendIn = group(curSold.filter((r) => r.customer_id != null), (r) => String(r.customer_id));
  const toCustomer = (id: number, xs: Row[] = []): Customer => {
    const l = life.get(id)!;
    return { id, name: l.name || "—", phone: l.phone, visits: xs.length, spend: sum(xs, net), lifetimeVisits: l.visits, lifetimeSpend: l.spend, lastVisit: l.last_day };
  };
  const topCustomers = [...spendIn]
    .map(([id, xs]) => toCustomer(Number(id), xs))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);
  const lapseCutoff = addDays(today, -LAPSED_DAYS);
  const winBack = lifetime
    .filter((c) => c.visits >= 2 && c.last_day < lapseCutoff)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10)
    .map((c) => toCustomer(c.id));
  const lapsedCount = lifetime.filter((c) => c.visits >= 2 && c.last_day < lapseCutoff).length;

  // --- Forward look ----------------------------------------------------------------------------
  const fwd = new Map(forwardRows.map((r) => [r.day, r]));
  const forwardDays = eachDay(today, addDays(today, 14)).map((day) => ({ day, bookings: fwd.get(day)?.bookings ?? 0, guests: fwd.get(day)?.guests ?? 0, revenue: fwd.get(day)?.revenue ?? 0 }));

  const out: Omit<Insights, "recommendations"> = {
    range: R,
    headline,
    retention: pc.ids.size ? retained / pc.ids.size : null,
    trend,
    products: productsOut,
    channels,
    payments,
    weekdays,
    heatmap: { hours, cells: heatCells },
    zones: { game: { cur: util("cur", "game"), prev: util("prev", "game") }, splatter: { cur: util("cur", "splatter"), prev: util("prev", "splatter") } },
    leadTime,
    partySize,
    demographics: { known, total: ids.length, age, gender: [...gender].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n) },
    leakage,
    memberships: membershipsOut,
    topCustomers,
    winBack,
    forward: { days: forwardDays, revenue: sum(forwardDays, (x) => x.revenue), bookings: sum(forwardDays, (x) => x.bookings), guests: sum(forwardDays, (x) => x.guests) },
  };
  return { ...out, recommendations: recommend(out, lapsedCount) };
}

// ---------------------------------------------------------------------------------------------
// Rule-based recommendations: each rule looks at one signal and says what to do about it.
// ---------------------------------------------------------------------------------------------

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pct = (x: number) => `${Math.round(x * 100)}%`;
const inr = (p: number) => "₹" + Math.round(p / 100).toLocaleString("en-IN");
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h >= 12 ? "pm" : "am"}`;

function recommend(x: Omit<Insights, "recommendations">, lapsedCount: number): Recommendation[] {
  const out: Recommendation[] = [];
  const h = x.headline;
  const growth = h.revenue.prev ? (h.revenue.cur - h.revenue.prev) / h.revenue.prev : null;

  if (growth != null && growth >= 0.05)
    out.push({ tone: "good", title: `Revenue up ${pct(growth)} on the previous period`, detail: `${inr(h.revenue.cur)} vs ${inr(h.revenue.prev)}. Check which products drove it below and lean into them.` });
  else if (growth != null && growth <= -0.05)
    out.push({ tone: "warning", title: `Revenue down ${pct(-growth)} on the previous period`, detail: `${inr(h.revenue.cur)} vs ${inr(h.revenue.prev)}. Look at the product and channel tables for where it fell.` });

  // Dead and full hours from the occupancy heatmap.
  const cells = x.heatmap.cells.filter((c): c is { dow: number; hour: number; util: number } => c.util != null);
  if (h.bookings.cur >= 10 && cells.length) {
    const dead = cells.filter((c) => c.util < 0.15).sort((a, b) => a.util - b.util);
    if (dead.length >= 3) {
      const sample = dead.slice(0, 3).map((c) => `${DOW[c.dow]} ${hourLabel(c.hour)}`).join(", ");
      out.push({
        tone: "opportunity",
        title: `${dead.length} weekly hour slots run under 15% full`,
        detail: `Quietest: ${sample}. A flash price or a school/college group offer in these hours sells seats that otherwise earn nothing.`,
        action: { label: "Set up flash prices", href: "/dashboard?tab=yield" },
      });
    }
    const hot = cells.filter((c) => c.util >= 0.8).sort((a, b) => b.util - a.util);
    if (hot.length) {
      const sample = hot.slice(0, 3).map((c) => `${DOW[c.dow]} ${hourLabel(c.hour)}`).join(", ");
      out.push({
        tone: "opportunity",
        title: `${hot.length} hour slots are 80%+ full`,
        detail: `Busiest: ${sample}. Demand here can carry a peak price, or a higher hold-back for walk-ins.`,
        action: { label: "Review prices", href: "/dashboard?tab=products" },
      });
    }
  }

  if (h.noShowRate.cur > 0.08)
    out.push({ tone: "warning", title: `No-shows at ${pct(h.noShowRate.cur)}`, detail: `${x.leakage.noShows} bookings worth ${inr(x.leakage.noShowValue)} didn't turn up. Take a deposit on phone bookings and make sure WhatsApp reminders are going out.`, action: { label: "Check messages", href: "/dashboard?tab=messages" } });

  if (x.leakage.onlineConversion != null && x.leakage.onlineConversion < 0.75 && x.leakage.abandoned >= 3)
    out.push({ tone: "warning", title: `${x.leakage.abandoned} checkouts abandoned (${inr(x.leakage.abandonedValue)})`, detail: `Only ${pct(x.leakage.onlineConversion)} of online holds were paid. Check the payment step works on mobile and that the hold window isn't too short.` });

  if (h.customers.cur >= 10 && h.repeatRate.cur < 0.25)
    out.push({ tone: "opportunity", title: `Only ${pct(h.repeatRate.cur)} of guests are returning`, detail: "A second-visit offer at checkout, or pitching memberships to groups of 3+, turns one-time visitors into regulars.", action: { label: "Memberships", href: "/dashboard?tab=memberships" } });
  else if (h.customers.cur >= 10 && h.repeatRate.cur >= 0.4)
    out.push({ tone: "good", title: `${pct(h.repeatRate.cur)} of guests are returning`, detail: "Loyalty is strong. A referral reward would turn regulars into a source of new customers." });

  if (lapsedCount > 0)
    out.push({ tone: "opportunity", title: `${lapsedCount} regulars haven't been back in ${LAPSED_DAYS}+ days`, detail: "They're listed under Win-back below, highest spend first. A personal WhatsApp with a comeback offer is the cheapest revenue you can get." });

  if (x.memberships.expiring30 > 0)
    out.push({ tone: "opportunity", title: `${x.memberships.expiring30} memberships expire in the next 30 days`, detail: "Reach out before they lapse. Renewing is far easier than winning them back later.", action: { label: "See members", href: "/dashboard?tab=memberships" } });

  if (x.leakage.soldOutSearches + x.leakage.waitlisted >= 5)
    out.push({ tone: "opportunity", title: "Demand you couldn't serve", detail: `${x.leakage.soldOutSearches} searches found no slot and ${x.leakage.waitlisted} guests joined a waitlist. Extending hours or adding rotation hours on those days would capture them.`, action: { label: "Day setup", href: "/dashboard?tab=day" } });

  const totalRev = h.revenue.cur;
  const online = x.channels.find((c) => c.id === "online");
  const enough = h.bookings.cur >= 20;
  if (enough && online && online.revenue / totalRev < 0.3)
    out.push({ tone: "opportunity", title: `Online is only ${pct(online.revenue / totalRev)} of revenue`, detail: "Guests who book ahead turn up in planned groups and fill quiet hours. Put the booking link in your Instagram bio, Google listing and mall signage." });

  const movers = x.products.filter((p) => enough && p.prevRevenue >= 500_000).map((p) => ({ ...p, g: (p.revenue - p.prevRevenue) / p.prevRevenue }));
  const riser = movers.filter((p) => p.g >= 0.2).sort((a, b) => b.g - a.g)[0];
  const faller = movers.filter((p) => p.g <= -0.2).sort((a, b) => a.g - b.g)[0];
  if (riser) out.push({ tone: "good", title: `${riser.name} is growing fast (+${pct(riser.g)})`, detail: "Feature it at the desk and in promotions while it has momentum." });
  if (faller) out.push({ tone: "warning", title: `${faller.name} is down ${pct(-faller.g)}`, detail: "Check whether its price, its availability or guest feedback changed." });

  const parties = x.products.filter((p) => p.id.startsWith("party"));
  const partyShare = parties.reduce((s, p) => s + p.share, 0);
  if (enough && partyShare < 0.15)
    out.push({ tone: "opportunity", title: `Parties are ${pct(partyShare)} of revenue`, detail: "Birthday and corporate events are your biggest tickets. Reach out to nearby offices, schools and event planners to grow this.", action: { label: "Parties", href: "/desk?tab=party" } });

  const order = { warning: 0, opportunity: 1, good: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}
