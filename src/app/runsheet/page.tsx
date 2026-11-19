"use client";

import { useEffect, useRef, useState } from "react";
import { StaffShell } from "@/components/StaffShell";
import { Spinner } from "@/components/ui";
import { fmtMin, nowIST, todayIST } from "@/lib/time";

interface Leg {
  code: string;
  product: string;
  shape: string;
  party: number;
  status: string;
  name: string;
  start: number;
  end: number;
  food: boolean;
  waiversOk: boolean;
}
interface Sheet {
  day: string;
  serverNow: number | null;
  openMin: number;
  closeMin: number;
  rooms: { id: string; name: string; zone: string; capacity: number; legs: Leg[]; blocks: { start: number; end: number; reason: string }[] }[];
  rotationHours: number[];
}

const SHAPE_COLOR: Record<string, string> = {
  grid20: "bg-cyan/25 border-cyan/60",
  rotation: "bg-fuchsia-500/25 border-fuchsia-400/70",
  splatter: "bg-lime/20 border-lime/60",
  combo: "bg-amber/20 border-amber/60",
  party: "bg-pink/30 border-pink/70",
};

export default function RunsheetPage() {
  return (
    <StaffShell min="floor" wide>
      <Runsheet />
    </StaffShell>
  );
}

function Runsheet() {
  const [day, setDay] = useState(todayIST());
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [live, setLive] = useState(false);
  const [nowSec, setNowSec] = useState(0);
  const offsetRef = useRef(0); // server minute − client minute, so the clock is the server's

  useEffect(() => {
    setSheet(null);
    const es = new EventSource(`/api/runsheet/stream?date=${day}`);
    es.onmessage = (e) => {
      const s = JSON.parse(e.data) as Sheet;
      if (s.serverNow != null) offsetRef.current = s.serverNow - nowIST().min;
      setSheet(s);
      setLive(true);
    };
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [day]);

  useEffect(() => {
    const update = () => {
      const d = new Date(Date.now() + 330 * 60_000);
      setNowSec((d.getUTCHours() * 60 + d.getUTCMinutes() + offsetRef.current) * 60 + d.getUTCSeconds());
    };
    const first = setTimeout(update, 0);
    const i = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(i);
    };
  }, []);

  const isToday = day === todayIST();
  const nowMin = Math.floor(nowSec / 60);

  if (!sheet) return <Spinner />;
  const span = sheet.closeMin - sheet.openMin;
  const pct = (m: number) => ((m - sheet.openMin) / span) * 100;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <input type="date" className="input w-auto" value={day} onChange={(e) => setDay(e.target.value)} />
        {isToday && <span className="text-2xl font-semibold tracking-tight">{fmtClock(nowSec)}</span>}
        <span className={`chip ${live ? "border-lime/50 text-lime" : "border-red/50 text-red"}`}>{live ? "live" : "reconnecting"}</span>
        <button className="btn btn-sm no-print ml-auto" onClick={() => window.print()}>
          Print
        </button>
      </div>

      {/* Now / next cards */}
      {isToday && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {sheet.rooms.map((r) => {
            const block = r.blocks.find((b) => b.start <= nowMin && nowMin < b.end);
            const curr = r.legs.filter((l) => l.start <= nowMin && nowMin < l.end && l.status !== "no_show");
            const next = r.legs.filter((l) => l.start > nowMin && l.status !== "no_show").sort((a, b) => a.start - b.start);
            const nextStart = next[0]?.start;
            const changeAt = curr.length ? Math.min(...curr.map((l) => l.end)) : block ? block.end : nextStart;
            const secsLeft = changeAt != null ? changeAt * 60 - nowSec : null;
            return (
              <div key={r.id} className={`card space-y-2 p-4 ${block ? "border-line bg-panel/40 opacity-70" : curr.length ? "border-cyan/50" : ""}`}>
                <div className="flex items-center justify-between">
                  <div className="font-semibold">{r.name}</div>
                  <div className="text-xs text-muted">cap {r.capacity}</div>
                </div>
                {block ? (
                  <div className="text-sm">
                    <div className="text-muted">{block.reason}</div>
                    <div className="text-2xl font-semibold tracking-tight">{fmtCountdown(secsLeft)}</div>
                  </div>
                ) : curr.length ? (
                  <div className="space-y-1 text-sm">
                    {curr.map((l) => (
                      <div key={l.code}>
                        <span className="font-mono">{l.code}</span> · {l.name} ×{l.party} {!l.waiversOk && <span className="text-amber">⚠ waivers</span>}
                      </div>
                    ))}
                    <div className="text-xs text-muted">changeover in</div>
                    <div className="text-2xl font-semibold tracking-tight text-cyan">{fmtCountdown(secsLeft)}</div>
                  </div>
                ) : (
                  <div className="text-sm text-muted">Free{nextStart != null ? ` · next ${fmtMin(nextStart)}` : ""}</div>
                )}
                {next[0] && curr.length > 0 && <div className="text-xs text-muted">Next: {next[0].code} @ {fmtMin(next[0].start)}</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* Timeline */}
      <div className="table-wrap">
        <div className="relative min-w-[1800px] p-3">
          <div className="relative ml-28 h-6 text-xs text-muted">
            {Array.from({ length: Math.ceil(span / 60) + 1 }, (_, i) => sheet.openMin + i * 60).filter((m) => m <= sheet.closeMin).map((m) => (
              <span key={m} className="absolute -translate-x-1/2" style={{ left: `${pct(m)}%` }}>
                {fmtMin(m)}
              </span>
            ))}
          </div>
          {sheet.rooms.map((r) => (
            <div key={r.id} className="flex items-stretch border-t border-line/60">
              <div className="w-28 shrink-0 py-3 pr-2 text-sm font-medium">
                {r.name}
                <div className="text-[10px] uppercase text-muted">{r.zone}</div>
              </div>
              <div className="relative h-16 flex-1">
                {sheet.rotationHours.map((h) => (
                  <div key={h} className="absolute inset-y-0 bg-fuchsia-500/5" style={{ left: `${pct(h * 60)}%`, width: `${(60 / span) * 100}%` }} />
                ))}
                {r.blocks.map((b, i) => (
                  <div
                    key={i}
                    title={`${b.reason} ${fmtMin(b.start)}–${fmtMin(b.end)}`}
                    className="absolute inset-y-1 rounded border border-dashed border-muted/40 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(154,151,179,0.15)_4px,rgba(154,151,179,0.15)_8px)]"
                    style={{ left: `${pct(b.start)}%`, width: `${((b.end - b.start) / span) * 100}%` }}
                  />
                ))}
                {stack(r.legs).map(({ leg: l, lane, lanes }) => (
                  <div
                    key={`${l.code}-${l.start}`}
                    title={`${l.code} ${l.product} · ${l.name} ×${l.party} · ${fmtMin(l.start)}–${fmtMin(l.end)}${l.food ? " · food" : ""}`}
                    className={`absolute overflow-hidden rounded border px-1 text-[10px] leading-tight ${SHAPE_COLOR[l.shape] ?? "bg-panel-2"} ${l.status === "no_show" ? "opacity-30 line-through" : ""} ${l.status === "hold" ? "border-dashed" : ""}`}
                    style={{ left: `${pct(l.start)}%`, width: `${((l.end - l.start) / span) * 100}%`, top: `${(lane / lanes) * 100}%`, height: `${100 / lanes}%` }}
                  >
                    <span className="font-mono">{l.code.slice(4)}</span> ×{l.party}
                  </div>
                ))}
                {isToday && nowMin >= sheet.openMin && nowMin <= sheet.closeMin && <div className="absolute inset-y-0 w-0.5 bg-red" style={{ left: `${pct(nowMin)}%` }} />}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-muted">
        {Object.entries({ grid20: "20-min games", rotation: "Rotation Hour (all 5)", splatter: "Splatter", combo: "Combo", party: "Party" }).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1">
            <span className={`inline-block h-3 w-5 rounded border ${SHAPE_COLOR[k]}`} /> {v}
          </span>
        ))}
        <span>▨ cleanup / deep clean / setup</span>
      </div>

      {/* Rotation hour Latin squares */}
      {sheet.rotationHours.map((h) => (
        <RotationSquare key={h} hour={h} sheet={sheet} />
      ))}
    </div>
  );
}

function RotationSquare({ hour, sheet }: { hour: number; sheet: Sheet }) {
  const start = hour * 60;
  const legStarts = [0, 1, 2, 3, 4].map((i) => start + i * 12);
  const groups = new Map<string, { name: string; party: number; rooms: string[] }>();
  for (const r of sheet.rooms) {
    for (const l of r.legs) {
      if (l.shape !== "rotation" || l.start < start || l.start >= start + 60 || l.status === "no_show") continue;
      const g = groups.get(l.code) ?? { name: l.name, party: l.party, rooms: Array(5).fill("") };
      g.rooms[legStarts.indexOf(l.start)] = r.name;
      groups.set(l.code, g);
    }
  }
  return (
    <div className="card">
      <div className="mb-2 font-semibold">Rotation Hour {fmtMin(start)} · everyone shifts one room every 12 min</div>
      <table className="data-table">
        <thead>
          <tr>
            <th className="py-1">Group</th>
            {legStarts.map((s) => (
              <th key={s} className="py-1 font-mono">
                {fmtMin(s)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...groups].map(([code, g]) => (
            <tr key={code}>
              <td className="py-1.5">
                <span className="font-mono">{code}</span> <span className="text-muted">{g.name} ×{g.party}</span>
              </td>
              {g.rooms.map((rm, i) => (
                <td key={i} className="py-1.5">
                  {rm}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Lay overlapping legs (several groups sharing a room) into lanes. */
function stack(legs: Leg[]) {
  const sorted = [...legs].sort((a, b) => a.start - b.start);
  const laneEnds: number[] = [];
  const placed = sorted.map((leg) => {
    let lane = laneEnds.findIndex((e) => e <= leg.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = leg.end;
    return { leg, lane };
  });
  const lanes = Math.max(1, laneEnds.length);
  return placed.map((p) => ({ ...p, lanes }));
}

function fmtClock(sec: number) {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor(sec / 60) % 60;
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function fmtCountdown(sec: number | null) {
  if (sec == null || sec < 0) return "—";
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
