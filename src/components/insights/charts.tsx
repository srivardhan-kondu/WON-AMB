"use client";

// Small dependency-free chart kit for the insights page. Mark specs: bars <= 24px with a 4px rounded
// data-end, 2px lines, >= 8px end-dots with a surface ring, 2px surface gaps between touching fills,
// hairline recessive gridlines, a hover tooltip on every plotted mark, text in text tokens only.

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Categorical slots (validated: first three pass all-pairs CVD on white) and the sequential blue ramp. */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a"] as const;
export const PREV = "#c3c7cf";
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const GRID = "#eceef2";

// --- formatting ------------------------------------------------------------------------------

/** Indian compact rupees: ₹8,450 · ₹1.2L · ₹3.4Cr */
export function inr(paise: number, compact = true): string {
  const r = paise / 100;
  const a = Math.abs(r);
  if (!compact || a < 100_000) return (r < 0 ? "−₹" : "₹") + Math.round(a).toLocaleString("en-IN");
  if (a < 10_000_000) return (r < 0 ? "−₹" : "₹") + trim(a / 100_000) + "L";
  return (r < 0 ? "−₹" : "₹") + trim(a / 10_000_000) + "Cr";
}
const trim = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(n >= 10 ? 1 : 2).replace(/\.?0+$/, ""));
export const pct = (x: number, dp = 0) => `${(x * 100).toFixed(dp)}%`;
export const num = (n: number) => n.toLocaleString("en-IN");

function niceStep(max: number, ticks = 4) {
  if (max <= 0) return 1;
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// --- shared pieces ---------------------------------------------------------------------------

export function Legend({ items }: { items: { label: string; color: string; line?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          {i.line ? <span className="h-0.5 w-4 rounded" style={{ background: i.color }} /> : <span className="h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} />}
          {i.label}
        </span>
      ))}
    </div>
  );
}

function Tip({ x, y, children, width }: { x: number; y: number; children: ReactNode; width: number }) {
  const left = Math.max(0, Math.min(x, width - 200));
  return (
    <div className="pointer-events-none absolute z-10 w-max max-w-[220px] rounded-lg border border-line bg-panel px-3 py-2 text-sm shadow-lg" style={{ left, top: Math.max(0, y - 8), transform: "translateY(-100%)" }}>
      {children}
    </div>
  );
}

export function TipRow({ color, label, value, line }: { color?: string; label: string; value: string; line?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {color && (line ? <span className="h-0.5 w-3 rounded" style={{ background: color }} /> : <span className="h-2 w-2 rounded-sm" style={{ background: color }} />)}
      <span className="text-muted">{label}</span>
      <span className="ml-auto pl-3 font-semibold tabular-nums">{value}</span>
    </div>
  );
}

// --- line chart: current period vs previous (same measure, one axis) ---------------------------

export function TrendLine({ points, fmt, height = 260 }: { points: { label: string; value: number; prev: number | null }[]; fmt: (n: number) => string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 56;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const n = points.length;
  const max = Math.max(1, ...points.map((p) => Math.max(p.value, p.prev ?? 0)));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const iw = Math.max(1, width - padL - padR);
  const ih = height - padT - padB;
  const x = (i: number) => padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => padT + ih - (v / top) * ih;
  const path = (vals: (number | null)[]) =>
    vals.reduce((s, v, i) => (v == null ? s : s + `${s && vals[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`), "");
  const cur = points.map((p) => p.value);
  const prev = points.map((p) => p.prev);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
  const last = n - 1;

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label="Trend chart">
          {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
              <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[12px] tabular-nums">
                {fmt(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i === last || (i % labelEvery === 0 && last - i >= labelEvery / 2 + 0.5) ? (
              <text key={i} x={x(i)} y={height - 8} textAnchor={i === 0 && n > 1 ? "start" : i === last && n > 1 ? "end" : "middle"} className="fill-muted text-[12px]">
                {p.label}
              </text>
            ) : null,
          )}
          <path d={`${path(cur)}L${x(last)},${y(0)}L${x(0)},${y(0)}Z`} fill={SERIES[0]} opacity={0.1} />
          {prev.some((v) => v != null) && <path d={path(prev)} fill="none" stroke={PREV} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          <path d={path(cur)} fill="none" stroke={SERIES[0]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ih} stroke="#9ca3af" strokeWidth={1} />}
          {(hover != null ? [hover] : [last]).map((i) => (
            <g key={i}>
              {hover != null && prev[i] != null && <circle cx={x(i)} cy={y(prev[i]!)} r={4} fill={PREV} stroke="#fff" strokeWidth={2} />}
              <circle cx={x(i)} cy={y(cur[i])} r={4.5} fill={SERIES[0]} stroke="#fff" strokeWidth={2} />
            </g>
          ))}
          {points.map((_, i) => (
            <rect
              key={i}
              x={x(i) - iw / Math.max(1, n - 1) / 2}
              y={padT}
              width={Math.max(8, iw / Math.max(1, n - 1))}
              height={ih}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
      )}
      {hover != null && (
        <Tip x={x(hover) + 10} y={y(Math.max(cur[hover], prev[hover] ?? 0))} width={width}>
          <div className="mb-1 font-semibold">{points[hover].label}</div>
          <TipRow color={SERIES[0]} line label="This period" value={fmt(cur[hover])} />
          {prev[hover] != null && <TipRow color={PREV} line label="Previous" value={fmt(prev[hover]!)} />}
          {prev[hover] ? <div className="mt-1 text-xs text-muted">{delta(cur[hover], prev[hover]!)}</div> : null}
        </Tip>
      )}
    </div>
  );
}

function delta(a: number, b: number) {
  const d = (a - b) / b;
  return `${d >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(d * 100))}% vs previous`;
}

// --- columns (single series, or stacked series) ----------------------------------------------

export function Columns({
  data,
  series,
  fmt,
  height = 200,
  labelAll,
}: {
  /** `sub` is a second axis line (e.g. a date); `note` only appears in the tooltip. */
  data: { label: string; sub?: string; note?: string; values: number[] }[];
  series: { label: string; color: string }[];
  fmt: (n: number) => string;
  height?: number;
  labelAll?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length;
  const totals = data.map((d) => d.values.reduce((s, v) => s + v, 0));
  const max = Math.max(1, ...totals);
  const maxIdx = totals.indexOf(Math.max(...totals));
  const hasSub = data.some((d) => d.sub);
  const axisH = hasSub ? 40 : 26;
  const plotH = height - axisH - 26;
  const slot = width / Math.max(1, n);
  const barW = Math.min(24, Math.max(3, slot * 0.6));
  // Thin the axis labels so they never collide (sized to the longest label).
  const labelPx = Math.max(...data.map((d) => Math.max(d.label.length, d.sub?.length ?? 0))) * 7 + 12;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(width / labelPx))));

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      <div className="flex items-end border-b border-gray-300" style={{ height: height - axisH }}>
        {data.map((d, i) => {
          const h = (totals[i] / max) * plotH;
          const showLabel = totals[i] > 0 && (labelAll || i === maxIdx);
          return (
            <div key={i} className="relative flex h-full min-w-0 flex-1 cursor-default flex-col items-center justify-end" onMouseEnter={() => setHover(i)}>
              {showLabel && <div className="mb-1 whitespace-nowrap text-xs font-medium tabular-nums">{fmt(totals[i])}</div>}
              <div className="flex flex-col-reverse gap-[2px]" style={{ width: barW, height: Math.max(h, totals[i] ? 3 : 0), opacity: hover == null || hover === i ? 1 : 0.55 }}>
                {d.values.map((v, s) =>
                  v > 0 ? (
                    <div
                      key={s}
                      className={s === d.values.findLastIndex((x) => x > 0) ? "rounded-t-[4px]" : ""}
                      style={{ background: series[s].color, flexGrow: v, minHeight: 2 }}
                    />
                  ) : null,
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex" style={{ height: axisH }}>
        {data.map((d, i) => (
          <div key={i} className="min-w-0 flex-1 overflow-visible whitespace-nowrap pt-1.5 text-center text-xs leading-tight text-muted">
            {i % every === 0 && (
              <>
                <div>{d.label}</div>
                {d.sub && <div className="text-[11px]">{d.sub}</div>}
              </>
            )}
          </div>
        ))}
      </div>
      {hover != null && (
        <Tip x={slot * hover + slot / 2 + 12} y={height - axisH - (totals[hover] / max) * plotH} width={width}>
          <div className="mb-1 font-semibold">
            {data[hover].label} {data[hover].sub}
          </div>
          {series.length > 1
            ? [...series.map((s, j) => <TipRow key={s.label} color={s.color} label={s.label} value={fmt(data[hover].values[j])} />), <TipRow key="t" label="Total" value={fmt(totals[hover])} />]
            : <TipRow color={series[0].color} label={series[0].label} value={fmt(totals[hover])} />}
          {data[hover].note && <div className="mt-1 text-xs text-muted">{data[hover].note}</div>}
        </Tip>
      )}
    </div>
  );
}

// --- horizontal bars (ranked lists, distributions) -------------------------------------------

export function HBars({ rows, fmt, color = SERIES[0], total }: { rows: { label: string; value: number; note?: string }[]; fmt: (n: number) => string; color?: string; total?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const sumAll = total ?? rows.reduce((s, r) => s + r.value, 0);
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="group grid grid-cols-[minmax(84px,34%)_1fr_auto] items-center gap-3 text-sm" title={`${r.label}: ${fmt(r.value)}${sumAll ? ` (${pct(r.value / sumAll)})` : ""}`}>
          <span className="truncate text-foreground">{r.label}</span>
          <span className="h-4">
            <span className="block h-full rounded-r-[4px] transition-opacity group-hover:opacity-80" style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value ? 3 : 0, background: color }} />
          </span>
          <span className="min-w-16 text-right tabular-nums">
            <span className="font-semibold">{fmt(r.value)}</span>
            {r.note && <span className="ml-1.5 text-xs text-muted">{r.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// --- segmented bar: one whole split into <= 3 parts ------------------------------------------

export function Segments({ parts, fmt }: { parts: { label: string; value: number }[]; fmt: (n: number) => string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const [hover, setHover] = useState<number | null>(null);
  if (!total) return <div className="text-sm text-muted">No data yet.</div>;
  return (
    <div>
      <div className="flex h-4 gap-[2px] overflow-hidden rounded-[4px]" onMouseLeave={() => setHover(null)}>
        {parts.map((p, i) =>
          p.value > 0 ? <div key={p.label} onMouseEnter={() => setHover(i)} title={`${p.label}: ${fmt(p.value)} (${pct(p.value / total)})`} style={{ flexGrow: p.value, background: SERIES[i], opacity: hover == null || hover === i ? 1 : 0.55 }} /> : null,
        )}
      </div>
      <div className="mt-3 space-y-1.5">
        {parts.map((p, i) => (
          <div key={p.label} className="flex items-center gap-2 text-sm">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[i] }} />
            <span>{p.label}</span>
            <span className="ml-auto font-semibold tabular-nums">{fmt(p.value)}</span>
            <span className="w-12 text-right text-muted tabular-nums">{pct(p.value / total)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- heatmap: weekday × hour, sequential blue ------------------------------------------------

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h >= 12 ? "p" : "a"}`;
const rampFor = (u: number) => RAMP[Math.min(RAMP.length - 1, Math.floor(u * RAMP.length))];

export function Heatmap({ hours, cells }: { hours: number[]; cells: { dow: number; hour: number; util: number | null }[] }) {
  const [hover, setHover] = useState<{ dow: number; hour: number; util: number | null } | null>(null);
  const at = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c]));
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate" style={{ borderSpacing: 2 }} onMouseLeave={() => setHover(null)}>
          <caption className="sr-only">Average seat occupancy by weekday and hour</caption>
          <thead>
            <tr>
              <th />
              {hours.map((h) => (
                <th key={h} scope="col" className="text-xs font-normal text-muted">
                  {hourLabel(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DOW.map((d, dow) => (
              <tr key={d}>
                <th scope="row" className="pr-2 text-left text-xs font-medium text-muted">
                  {d}
                </th>
                {hours.map((h) => {
                  const c = at.get(`${dow}:${h}`);
                  const u = c?.util ?? null;
                  const active = hover?.dow === dow && hover?.hour === h;
                  return (
                    <td
                      key={h}
                      onMouseEnter={() => setHover(c ?? { dow, hour: h, util: null })}
                      aria-label={`${d} ${hourLabel(h)}: ${u == null ? "closed" : pct(u)}`}
                      className="h-8 min-w-7 rounded-[4px]"
                      style={{ background: u == null ? "#f3f4f6" : rampFor(u), boxShadow: active ? "0 0 0 2px #111827" : undefined }}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <div className="flex items-center gap-2">
          <span>0%</span>
          <div className="flex gap-[2px]">
            {RAMP.map((c) => (
              <span key={c} className="h-3 w-6 rounded-[2px]" style={{ background: c }} />
            ))}
          </div>
          <span>100% full</span>
          <span className="ml-2 inline-flex items-center gap-1">
            <span className="h-3 w-3 rounded-[2px] bg-[#f3f4f6]" /> closed / no data
          </span>
        </div>
        <div className="min-h-5 text-sm text-foreground">
          {hover ? (
            <>
              <b>
                {DOW[hover.dow]} {hourLabel(hover.hour)}m
              </b>{" "}
              — {hover.util == null ? "closed" : `${pct(hover.util)} of seats used on average`}
            </>
          ) : (
            <span className="text-muted">Hover a cell for the exact figure</span>
          )}
        </div>
      </div>
    </div>
  );
}

// --- stat tile with optional sparkline -------------------------------------------------------

export function Stat({ label, value, cur, prev, invert, spark, hint, ratioDelta }: { label: string; value: string; cur: number; prev: number; invert?: boolean; spark?: number[]; hint?: string; ratioDelta?: boolean }) {
  // Rates compare in percentage points; amounts and counts in relative %.
  const d = ratioDelta ? cur - prev : prev ? (cur - prev) / prev : null;
  const flat = d == null || Math.abs(d) < 0.005;
  const good = flat ? null : invert ? d! < 0 : d! > 0;
  return (
    <div className="stat flex flex-col">
      <div className="text-sm font-medium text-muted">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="text-[1.6rem] font-semibold leading-tight tracking-tight tabular-nums">{value}</div>
        {spark && spark.length > 1 && <Spark values={spark} />}
      </div>
      <div className={`mt-1 text-sm ${good == null ? "text-muted" : good ? "text-lime" : "text-red"}`}>
        {d == null ? (
          prev === 0 && cur > 0 ? "new this period" : "no previous data"
        ) : flat ? (
          "→ flat vs previous"
        ) : (
          <>
            {d > 0 ? "▲" : "▼"} {ratioDelta ? `${Math.abs(Math.round(d * 1000) / 10)} pts` : `${Math.abs(Math.round(d * 100))}%`} <span className="text-muted">vs previous</span>
          </>
        )}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const w = 84;
  const h = 28;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - (v / max) * (h - 6)).toFixed(1)}`);
  const last = pts[pts.length - 1].split(",");
  return (
    <svg width={w} height={h} aria-hidden className="shrink-0">
      <polyline points={pts.join(" ")} fill="none" stroke={PREV} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={3.5} fill={SERIES[0]} stroke="#fff" strokeWidth={1.5} />
    </svg>
  );
}
