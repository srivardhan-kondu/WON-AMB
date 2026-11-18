"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { addDays, fmtDay, rupees, todayIST, weekStart } from "@/lib/time";
import { ErrorNote, Spinner } from "@/components/ui";

interface WeekKpis {
  weekStart: string;
  revenuePaise: number;
  bookings: number;
  guests: number;
  utilization: { game: number; splatter: number };
  revpashPaise: number;
  noShowRate: number;
  walkInShare: number;
  walkInConversion: number | null;
  holdbackSeatHours: number;
  rejections: number;
  falseSellouts: number;
  falseSelloutRate: number;
  refundsPaise: number;
  partyLeadDays: number | null;
  byProduct: { id: string; name: string; bookings: number; guests: number; revenuePaise: number }[];
  hourly: { hour: number; game: number; splatter: number }[];
  daily: { day: string; revenuePaise: number; bookings: number }[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function Tile({ label, value, prev, fmt, invert }: { label: string; value: number; prev: number; fmt: (n: number) => string; invert?: boolean }) {
  const delta = prev ? (value - prev) / prev : null;
  const good = delta == null ? null : invert ? delta < 0 : delta > 0;
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 font-mono text-2xl">{fmt(value)}</div>
      <div className={`text-xs ${good == null ? "text-muted" : good ? "text-lime" : "text-red"}`}>
        {delta == null ? `last week ${fmt(prev)}` : `${delta > 0 ? "▲" : "▼"} ${Math.abs(Math.round(delta * 100))}% vs ${fmt(prev)}`}
      </div>
    </div>
  );
}

export function Kpis() {
  const [week, setWeek] = useState(weekStart(todayIST()));
  const [data, setData] = useState<{ current: WeekKpis; previous: WeekKpis } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api<{ current: WeekKpis; previous: WeekKpis }>(`/api/kpis?week=${week}`).then(setData).catch((e: Error) => setErr(e.message));
  }, [week]);

  if (err) return <ErrorNote error={err} />;
  if (!data) return <Spinner />;
  const c = data.current;
  const p = data.previous;
  const maxRev = Math.max(1, ...c.daily.map((d) => d.revenuePaise));

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <button className="btn btn-sm" onClick={() => setWeek(addDays(week, -7))}>
          ←
        </button>
        <span className="text-sm">
          Week of <b>{fmtDay(week)}</b>
        </span>
        <button className="btn btn-sm" onClick={() => setWeek(addDays(week, 7))}>
          →
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Revenue" value={c.revenuePaise} prev={p.revenuePaise} fmt={rupees} />
        <Tile label="RevPASH" value={c.revpashPaise} prev={p.revpashPaise} fmt={rupees} />
        <Tile label="Game zone utilization" value={c.utilization.game} prev={p.utilization.game} fmt={pct} />
        <Tile label="Splatter utilization" value={c.utilization.splatter} prev={p.utilization.splatter} fmt={pct} />
        <Tile label="Bookings" value={c.bookings} prev={p.bookings} fmt={String} />
        <Tile label="Guests" value={c.guests} prev={p.guests} fmt={String} />
        <Tile label="No-show rate" value={c.noShowRate} prev={p.noShowRate} fmt={pct} invert />
        <Tile label="Walk-in / desk share" value={c.walkInShare} prev={p.walkInShare} fmt={pct} />
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wider text-muted">Walk-in conversion</div>
          <div className="mt-1 font-mono text-2xl">{c.walkInConversion == null ? "—" : pct(c.walkInConversion)}</div>
          <div className="text-xs text-muted">
            held-back seats sold · {c.holdbackSeatHours} seat-h held · last week {p.walkInConversion == null ? "—" : pct(p.walkInConversion)}
          </div>
        </div>
        <div className={`card p-4 ${c.falseSellouts > 0 ? "border-red/60" : ""}`}>
          <div className="text-xs uppercase tracking-wider text-muted">False sell-out rate</div>
          <div className={`mt-1 font-mono text-2xl ${c.falseSellouts > 0 ? "text-red" : "text-lime"}`}>{pct(c.falseSelloutRate)}</div>
          <div className="text-xs text-muted">
            {c.falseSellouts} of {c.rejections} rejected searches · must stay 0
          </div>
        </div>
        <Tile label="Refunds (owner-approved)" value={c.refundsPaise} prev={p.refundsPaise} fmt={rupees} invert />
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wider text-muted">Party lead time</div>
          <div className="mt-1 font-mono text-2xl">{c.partyLeadDays == null ? "—" : `${c.partyLeadDays} d`}</div>
          <div className="text-xs text-muted">last week {p.partyLeadDays == null ? "—" : `${p.partyLeadDays} d`}</div>
        </div>
      </div>
      {c.falseSellouts > 0 && <div className="rounded-xl border border-red/40 bg-red/10 p-3 text-sm text-red">A search was refused while rooms could have seated it. This is an engine bug: check the server log for &quot;FALSE SELL-OUT&quot;.</div>}
      {c.walkInConversion != null && c.walkInConversion < 0.3 && c.holdbackSeatHours > 0 && (
        <div className="rounded-xl border border-amber/40 bg-amber/10 p-3 text-sm text-amber">
          Only {pct(c.walkInConversion)} of the {c.holdbackSeatHours} held-back seat-hours sold: consider lowering hold-back % in Day config.
        </div>
      )}
      {c.noShowRate > 0.08 && <div className="rounded-xl border border-amber/40 bg-amber/10 p-3 text-sm text-amber">No-show rate above 8% — consider tighter reminders or deposits.</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="mb-3 text-sm font-semibold">Revenue by day</div>
          <div className="flex h-40 items-end gap-2">
            {c.daily.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                <div className="w-full rounded-t bg-gradient-to-t from-pink to-fuchsia-400" style={{ height: `${(d.revenuePaise / maxRev) * 100}%`, minHeight: d.revenuePaise ? 2 : 0 }} title={rupees(d.revenuePaise)} />
                <div className="text-[10px] text-muted">{fmtDay(d.day).split(",")[0]}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="mb-3 text-sm font-semibold">Utilization by daypart (week)</div>
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr>
                <th className="text-left">Zone</th>
                {c.hourly.map((h) => (
                  <th key={h.hour} className="font-normal">
                    {h.hour}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["game", "splatter"] as const).map((z) => (
                <tr key={z}>
                  <td className="py-1 pr-2 capitalize">{z}</td>
                  {c.hourly.map((h) => (
                    <td key={h.hour} className="p-0.5">
                      <div className="h-6 rounded" style={{ background: `rgba(34,227,255,${0.08 + h[z] * 0.9})` }} title={pct(h[z])} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">Darker = fuller. Dead hours are candidates for flash offers; full peak hours for higher hold-back.</p>
        </div>
      </div>

      <div className="card">
        <div className="mb-2 text-sm font-semibold">By product</div>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1">Product</th>
              <th>Bookings</th>
              <th>Guests</th>
              <th className="text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {c.byProduct.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="py-1.5">{r.name}</td>
                <td>{r.bookings}</td>
                <td>{r.guests}</td>
                <td className="text-right font-mono">{rupees(r.revenuePaise)}</td>
              </tr>
            ))}
            {c.byProduct.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-muted">
                  No sales this week yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
