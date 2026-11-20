"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/client";
import { fmtDay } from "@/lib/time";
import type { Insights as Data, RangeKey, Recommendation } from "@/lib/insights";
import { Icon } from "@/components/icons";
import { ErrorNote, Spinner } from "@/components/ui";
import { Columns, HBars, Heatmap, Legend, PREV, SERIES, Segments, Stat, TrendLine, inr, num, pct } from "./charts";

const RANGE_TABS: { key: RangeKey; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "12m", label: "12 months" },
  { key: "mtd", label: "This month" },
];
const CHANNEL_LABEL: Record<string, string> = { online: "Online", desk: "Walk-in (desk)", phone: "Phone" };
const GENDER_LABEL: Record<string, string> = { male: "Male", female: "Female", other: "Other" };
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function Insights() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const q = params.get("range");
  const range = (RANGE_TABS.some((r) => r.key === q) ? q : "30d") as RangeKey;
  const [state, setState] = useState<{ range: RangeKey; data: Data | null; err: string | null } | null>(null);
  const [metric, setMetric] = useState<"revenue" | "bookings" | "guests">("revenue");
  const data = state?.data ?? null;
  const err = state?.range === range ? state.err : null;
  const loading = state?.range !== range;

  useEffect(() => {
    let live = true;
    api<Data>(`/api/insights?range=${range}`)
      .then((d) => live && setState({ range, data: d, err: null }))
      .catch((e: Error) => live && setState((s) => ({ range, data: s?.data ?? null, err: e.message })));
    return () => {
      live = false;
    };
  }, [range]);

  const setRange = (r: RangeKey) => router.replace(`${path}?range=${r}`, { scroll: false });

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <div className="no-print flex flex-wrap items-center gap-3">
        <div className="tabbar">
          {RANGE_TABS.map((r) => (
            <button key={r.key} className={`tab ${r.key === range ? "tab-active" : ""}`} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        {data && (
          <span className="text-sm text-muted">
            {longDay(data.range.from)} – {longDay(data.range.today)} · compared with the {data.range.days} days before
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {loading && data && <Spinner />}
          <button className="btn btn-sm" onClick={() => window.print()}>
            <Icon name="printer" className="h-4 w-4" /> Print / PDF
          </button>
        </div>
      </div>

      <ErrorNote error={err} />
      {!data ? (
        !err && (
          <div className="flex h-64 items-center justify-center text-muted">
            <Spinner />
          </div>
        )
      ) : (
        <div className={`space-y-6 transition-opacity ${loading ? "opacity-60" : ""}`}>
          <Body d={data} metric={metric} setMetric={setMetric} />
        </div>
      )}
    </div>
  );
}

const longDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function Body({ d, metric, setMetric }: { d: Data; metric: "revenue" | "bookings" | "guests"; setMetric: (m: "revenue" | "bookings" | "guests") => void }) {
  const h = d.headline;
  const spark = d.trend.map((t) => t.revenue);
  const grainWord = d.range.grain === "day" ? "Daily" : d.range.grain === "week" ? "Weekly" : "Monthly";
  const empty = h.bookings.cur === 0 && h.bookings.prev === 0;

  return (
    <>
      {empty && (
        <div className="card border-amber/30 bg-amber/5 text-amber">
          No sales in this range or the one before it yet. The charts fill in as bookings come in. Try a longer range.
        </div>
      )}

      {/* Headline KPIs */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
        <Stat label="Net revenue" value={inr(h.revenue.cur)} cur={h.revenue.cur} prev={h.revenue.prev} spark={spark} />
        <Stat label="Bookings" value={num(h.bookings.cur)} cur={h.bookings.cur} prev={h.bookings.prev} />
        <Stat label="Guests" value={num(h.guests.cur)} cur={h.guests.cur} prev={h.guests.prev} />
        <Stat label="Avg booking value" value={inr(h.aov.cur)} cur={h.aov.cur} prev={h.aov.prev} />
        <Stat label="Revenue per guest" value={inr(h.perGuest.cur)} cur={h.perGuest.cur} prev={h.perGuest.prev} />
        <Stat label="Seat occupancy" value={pct(h.utilization.cur)} cur={h.utilization.cur} prev={h.utilization.prev} ratioDelta hint="seat-minutes used / open" />
        <Stat label="Unique customers" value={num(h.customers.cur)} cur={h.customers.cur} prev={h.customers.prev} />
        <Stat label="New customers" value={num(h.newCustomers.cur)} cur={h.newCustomers.cur} prev={h.newCustomers.prev} />
        <Stat label="Repeat customers" value={pct(h.repeatRate.cur)} cur={h.repeatRate.cur} prev={h.repeatRate.prev} ratioDelta hint={d.retention == null ? undefined : `${pct(d.retention)} of last period's guests came back`} />
        <Stat label="No-show rate" value={pct(h.noShowRate.cur, 1)} cur={h.noShowRate.cur} prev={h.noShowRate.prev} invert ratioDelta />
        <Stat label="Cancellation rate" value={pct(h.cancelRate.cur, 1)} cur={h.cancelRate.cur} prev={h.cancelRate.prev} invert ratioDelta />
        <Stat label="Refunds" value={inr(h.refunds.cur)} cur={h.refunds.cur} prev={h.refunds.prev} invert />
      </section>

      {/* Recommendations */}
      <Recommendations items={d.recommendations} />

      {/* Trend */}
      <Card
        title={`${grainWord} ${metric}`}
        sub={metric === "revenue" ? "Net of refunds, by visit date. The grey line is the previous period, lined up from its end." : "By visit date"}
        right={
          <div className="tabbar no-print">
            {(["revenue", "bookings", "guests"] as const).map((m) => (
              <button key={m} className={`tab text-sm capitalize ${metric === m ? "tab-active" : ""}`} onClick={() => setMetric(m)}>
                {m}
              </button>
            ))}
          </div>
        }
      >
        {metric === "revenue" && (
          <div className="mb-2">
            <Legend items={[{ label: "This period", color: SERIES[0], line: true }, { label: "Previous period", color: PREV, line: true }]} />
          </div>
        )}
        <TrendLine
          points={d.trend.map((t) => ({ label: t.label, value: t[metric], prev: metric === "revenue" ? t.prevRevenue : null }))}
          fmt={metric === "revenue" ? (n) => inr(n) : num}
        />
      </Card>

      {/* Products + channels */}
      <div className="grid gap-6 2xl:grid-cols-3">
        <Card title="Revenue by product" sub="Where the money comes from, and how each product moved against the previous period" className="2xl:col-span-2">
          <ProductTable d={d} />
        </Card>
        <div className="grid content-start gap-6 lg:grid-cols-2 2xl:grid-cols-1">
          <Card title="Sales channel" sub="Share of net revenue">
            <Segments parts={d.channels.map((c) => ({ label: CHANNEL_LABEL[c.id] ?? c.id, value: c.revenue }))} fmt={(n) => inr(n)} />
            <div className="mt-3 border-t border-line pt-3 text-sm text-muted">
              {d.channels.map((c) => (
                <div key={c.id} className="flex justify-between">
                  <span>{CHANNEL_LABEL[c.id]} bookings</span>
                  <span className="tabular-nums text-foreground">
                    {num(c.bookings)} <Growth cur={c.revenue} prev={c.prevRevenue} />
                  </span>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Payment methods" sub="Net revenue by how guests paid">
            {d.payments.length ? <HBars rows={d.payments.map((p) => ({ label: p.id.replace(/_/g, " "), value: p.revenue, note: `${p.bookings}` }))} fmt={(n) => inr(n)} /> : <Empty />}
          </Card>
        </div>
      </div>

      {/* Demand */}
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="When are you busy?" sub="Average share of seats in use, by weekday and hour. Pale cells are the hours to fill with offers; dark ones can carry a higher price." className="xl:col-span-2">
          <Heatmap hours={d.heatmap.hours} cells={d.heatmap.cells} />
        </Card>
        <Card title="Average day" sub="Net revenue on an average day of each weekday">
          <Columns
            data={d.weekdays.map((w) => ({ label: DOW[w.dow], note: `${w.avgGuests} guests on an average ${DOW[w.dow]} · ${w.days} days counted`, values: [w.avgRevenue] }))}
            series={[{ label: "Avg revenue", color: SERIES[0] }]}
            fmt={(n) => inr(n)}
            labelAll
          />
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-sm">
            <ZoneStat label="Game zone" v={d.zones.game} />
            <ZoneStat label="Splatter zone" v={d.zones.splatter} />
          </div>
        </Card>
      </div>

      {/* Customers */}
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="New vs returning customers" sub={`Unique customers per ${d.range.grain}`} className="xl:col-span-2">
          <div className="mb-3">
            <Legend items={[{ label: "New", color: SERIES[0] }, { label: "Returning", color: SERIES[1] }]} />
          </div>
          <Columns
            data={d.trend.map((t) => ({ label: t.label, values: [t.newCustomers, t.returning] }))}
            series={[{ label: "New", color: SERIES[0] }, { label: "Returning", color: SERIES[1] }]}
            fmt={num}
            height={220}
          />
        </Card>
        <Card title="Who visits" sub={d.demographics.total ? `Lead guest profile, ${d.demographics.known} of ${d.demographics.total} customers recorded` : "Lead guest profile"}>
          {d.demographics.known ? (
            <div className="space-y-5">
              <Segments parts={d.demographics.gender.map((g) => ({ label: GENDER_LABEL[g.id] ?? g.id, value: g.n }))} fmt={num} />
              <HBars rows={d.demographics.age.map((a) => ({ label: a.label, value: a.n }))} fmt={num} />
            </div>
          ) : (
            <Empty>Age and gender are recorded at the desk on new bookings. They&apos;ll show here once captured.</Empty>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="How far ahead guests book" sub="Bookings by days between booking and visit">
          <HBars rows={d.leadTime.map((l) => ({ label: l.label, value: l.bookings }))} fmt={num} />
        </Card>
        <Card title="Group size" sub="Bookings by number of guests">
          <HBars rows={d.partySize.map((l) => ({ label: l.label, value: l.bookings }))} fmt={num} />
        </Card>
      </div>

      {/* Lists */}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Top customers" sub="Highest spend this period">
          <CustomerTable rows={d.topCustomers} mode="top" />
        </Card>
        <Card title="Win-back" sub="Regulars (2+ visits) who haven't been back in 45+ days, highest lifetime spend first">
          <CustomerTable rows={d.winBack} mode="winback" />
        </Card>
      </div>

      {/* Leakage, memberships, forward */}
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Revenue leakage" sub="Money and demand lost this period">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
            <Mini label="No-shows" value={num(d.leakage.noShows)} sub={inr(d.leakage.noShowValue) + " booked"} />
            <Mini label="Cancellations" value={num(d.leakage.cancellations)} sub={inr(d.leakage.cancelValue)} />
            <Mini label="Abandoned checkouts" value={num(d.leakage.abandoned)} sub={inr(d.leakage.abandonedValue)} />
            <Mini label="Online checkout paid" value={d.leakage.onlineConversion == null ? "—" : pct(d.leakage.onlineConversion)} sub="holds that were paid" />
            <Mini label="Sold-out searches" value={num(d.leakage.soldOutSearches)} sub="no slot available" />
            <Mini label="Waitlisted" value={num(d.leakage.waitlisted)} sub={`${d.leakage.waitlistConverted} converted`} />
          </dl>
        </Card>
        <Card title="Memberships" sub="Recurring revenue base">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
            <Mini label="Active" value={num(d.memberships.active)} />
            <Mini label="Expiring in 30 days" value={num(d.memberships.expiring30)} />
            <Mini label="Sold this period" value={num(d.memberships.newInPeriod)} />
            <Mini label="Member visits" value={num(d.memberships.visitsInPeriod)} sub="this period" />
          </dl>
          {d.memberships.plans.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <HBars rows={d.memberships.plans.map((p) => ({ label: p.plan, value: p.active }))} fmt={num} />
            </div>
          )}
        </Card>
        <Card title="Next 14 days" sub={`${inr(d.forward.revenue)} already booked · ${num(d.forward.bookings)} bookings · ${num(d.forward.guests)} guests`}>
          <Columns
            data={d.forward.days.map((x, i) => ({ label: i === 0 ? "Today" : fmtDay(x.day).split(",")[0].slice(0, 2), sub: x.day.slice(8), values: [x.revenue] }))}
            series={[{ label: "Booked revenue", color: SERIES[0] }]}
            fmt={(n) => inr(n)}
            height={190}
          />
          <p className="mt-2 text-xs text-muted">Thin days ahead are the ones to push on social and WhatsApp now.</p>
        </Card>
      </div>
    </>
  );
}

// --- pieces ----------------------------------------------------------------------------------

function Card({ title, sub, right, children, className = "" }: { title: string; sub?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card break-inside-avoid ${className}`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="card-title">{title}</h2>
          {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children?: ReactNode }) {
  return <div className="py-6 text-center text-sm text-muted">{children ?? "No data in this range."}</div>;
}

function Mini({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
      {sub && <dd className="text-xs text-muted">{sub}</dd>}
    </div>
  );
}

function Growth({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return cur ? <span className="ml-1 text-xs text-muted">new</span> : null;
  const g = (cur - prev) / prev;
  if (Math.abs(g) < 0.005) return <span className="ml-1 text-xs text-muted">→ 0%</span>;
  return (
    <span className={`ml-1 text-xs font-medium ${g > 0 ? "text-lime" : "text-red"}`}>
      {g > 0 ? "▲" : "▼"} {Math.abs(Math.round(g * 100))}%
    </span>
  );
}

function ZoneStat({ label, v }: { label: string; v: { cur: number; prev: number } }) {
  const dPts = Math.round((v.cur - v.prev) * 1000) / 10;
  return (
    <div>
      <div className="text-muted">{label} occupancy</div>
      <div className="text-xl font-semibold tabular-nums">{pct(v.cur)}</div>
      <div className={`text-xs ${dPts === 0 ? "text-muted" : dPts > 0 ? "text-lime" : "text-red"}`}>
        {dPts === 0 ? "→ flat" : `${dPts > 0 ? "▲" : "▼"} ${Math.abs(dPts)} pts`}
      </div>
    </div>
  );
}

const TONE: Record<Recommendation["tone"], { label: string; icon: "check" | "alert" | "trending"; cls: string }> = {
  warning: { label: "Needs attention", icon: "alert", cls: "border-amber/25 bg-amber/5 text-amber" },
  opportunity: { label: "Opportunity", icon: "trending", cls: "border-cyan/25 bg-cyan/5 text-cyan" },
  good: { label: "Doing well", icon: "check", cls: "border-lime/25 bg-lime/5 text-lime" },
};

function Recommendations({ items }: { items: Recommendation[] }) {
  if (!items.length) return null;
  return (
    <section className="card break-inside-avoid">
      <div className="mb-4 flex items-center gap-2">
        <Icon name="bulb" className="h-6 w-6 text-pink" />
        <h2 className="card-title">What to do next</h2>
        <span className="text-sm text-muted">· {items.length} insights from this period&apos;s numbers</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((r, i) => {
          const t = TONE[r.tone];
          return (
            <div key={i} className="flex flex-col rounded-lg border border-line p-4">
              <span className={`chip mb-2 self-start normal-case ${t.cls}`}>
                <Icon name={t.icon} className="mr-1 h-3.5 w-3.5" />
                {t.label}
              </span>
              <div className="font-semibold leading-snug">{r.title}</div>
              <p className="mt-1 flex-1 text-sm text-muted">{r.detail}</p>
              {r.action && (
                <Link href={r.action.href} className="no-print mt-3 text-sm font-medium text-pink hover:underline">
                  {r.action.label} →
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ProductTable({ d }: { d: Data }) {
  const rows = d.products.filter((p) => p.revenue > 0 || p.prevRevenue > 0);
  if (!rows.length) return <Empty />;
  const max = Math.max(1, ...rows.map((r) => r.revenue));
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Revenue</th>
            <th className="text-right">Share</th>
            <th className="text-right">Bookings</th>
            <th className="text-right">Avg group</th>
            <th className="text-right">Avg ticket</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="min-w-[150px] font-medium">{p.name}</td>
              <td>
                <div className="flex items-center gap-2">
                  <span className="h-3 shrink-0 rounded-r-[4px]" style={{ width: `${(p.revenue / max) * 56}px`, minWidth: p.revenue ? 3 : 0, background: SERIES[0] }} />
                  <span className="whitespace-nowrap font-semibold tabular-nums">{inr(p.revenue)}</span>
                  <Growth cur={p.revenue} prev={p.prevRevenue} />
                </div>
              </td>
              <td className="text-right tabular-nums">{pct(p.share)}</td>
              <td className="text-right tabular-nums">{num(p.bookings)}</td>
              <td className="text-right tabular-nums">{p.bookings ? (p.guests / p.bookings).toFixed(1) : "—"}</td>
              <td className="text-right tabular-nums">{p.bookings ? inr(p.revenue / p.bookings) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CustomerTable({ rows, mode }: { rows: Data["topCustomers"]; mode: "top" | "winback" }) {
  if (!rows.length) return <Empty>{mode === "winback" ? "No lapsed regulars. Everyone's still coming back." : "No customer bookings in this range."}</Empty>;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th className="text-right">{mode === "top" ? "Spend" : "Lifetime spend"}</th>
            <th className="text-right">Visits</th>
            <th className="text-right">Last visit</th>
            <th className="no-print" />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-muted tabular-nums">{c.phone}</div>
              </td>
              <td className="text-right font-semibold tabular-nums">
                {inr(mode === "top" ? c.spend : c.lifetimeSpend)}
                {mode === "top" && <div className="text-xs font-normal text-muted">{inr(c.lifetimeSpend)} lifetime</div>}
              </td>
              <td className="text-right tabular-nums">
                {mode === "top" ? c.visits : c.lifetimeVisits}
                {mode === "top" && <div className="text-xs text-muted">{c.lifetimeVisits} total</div>}
              </td>
              <td className="whitespace-nowrap text-right text-sm">{fmtDay(c.lastVisit).replace(/^\w+, /, "")}</td>
              <td className="no-print text-right">
                <a className="btn btn-sm px-2.5" href={`https://wa.me/${c.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" title={`WhatsApp ${c.name}`} aria-label={`WhatsApp ${c.name}`}>
                  <Icon name="chat" className="h-4 w-4" />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
