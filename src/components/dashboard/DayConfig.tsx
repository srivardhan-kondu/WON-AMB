"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { addDays, fmtDay, fmtMin, todayIST } from "@/lib/time";
import { ErrorNote, Field, Spinner } from "@/components/ui";
import { atLeast, useStaff } from "@/components/StaffShell";

interface Cfg {
  day: string;
  openMin: number;
  closeMin: number;
  peakHours: number[];
  rotationHours: number[];
  holdbackPct: number;
  deepCleanStart: number | null;
  deepCleanMin: number;
  deepCleanZone: "game" | "splatter";
  peakOverride: boolean | null;
  hasOverride: boolean;
  all5Mode: "rotation" | "grid";
  all5Override: "rotation" | "grid" | null;
}

interface RoomRow { id: string; name: string; zone: string }
interface ManualBlock { id: number; room_id: string; start_min: number; end_min: number; reason: string; created_by: string | null }

const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromTime = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

export function DayConfigEditor() {
  const staff = useStaff();
  const [day, setDay] = useState(todayIST());
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [peak, setPeak] = useState<"auto" | "peak" | "offpeak">("auto");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setCfg(null);
    api<Cfg>(`/api/day-config/${day}`).then((c) => {
      setCfg(c);
      setPeak(c.peakOverride == null ? "auto" : c.peakOverride ? "peak" : "offpeak");
    });
  }, [day]);

  async function save(reset = false) {
    if (!cfg) return;
    setErr(null);
    setMsg(null);
    try {
      const c = await api<Cfg>(`/api/day-config/${day}`, {
        method: "PUT",
        body: { openMin: cfg.openMin, closeMin: cfg.closeMin, peak, holdbackPct: cfg.holdbackPct, deepCleanStart: cfg.deepCleanStart, deepCleanMin: cfg.deepCleanMin, deepCleanZone: cfg.deepCleanZone, rotationHours: cfg.rotationHours, all5Mode: cfg.all5Override, reset },
      });
      setCfg(c);
      setPeak(c.peakOverride == null ? "auto" : c.peakOverride ? "peak" : "offpeak");
      setMsg(reset ? "Reset to venue defaults" : "Saved — the engine uses this immediately");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {Array.from({ length: 14 }, (_, i) => addDays(todayIST(), i)).map((d) => (
          <button key={d} onClick={() => setDay(d)} className={`min-w-[88px] rounded-xl border px-2 py-2 text-xs ${day === d ? "border-pink bg-pink/10" : "border-line"}`}>
            {fmtDay(d)}
          </button>
        ))}
        <input type="date" className="input w-auto" value={day} onChange={(e) => setDay(e.target.value)} />
      </div>
      {!cfg ? (
        <Spinner />
      ) : (
        <div className="card grid gap-4 md:grid-cols-2">
          <Field label="Open">
            <input type="time" step={1200} className="input" value={toTime(cfg.openMin)} onChange={(e) => setCfg({ ...cfg, openMin: fromTime(e.target.value) })} />
          </Field>
          <Field label="Close">
            <input type="time" step={1200} className="input" value={toTime(cfg.closeMin)} onChange={(e) => setCfg({ ...cfg, closeMin: fromTime(e.target.value) })} />
          </Field>
          <Field label="Peak calendar" hint={`Auto: Fri 5 pm+ and weekends. Current peak hours: ${cfg.peakHours.length ? cfg.peakHours.map((h) => fmtMin(h * 60)).join(", ") : "none"}`}>
            <select className="input" value={peak} onChange={(e) => setPeak(e.target.value as typeof peak)}>
              <option value="auto">Auto</option>
              <option value="peak">Whole day peak (holiday)</option>
              <option value="offpeak">Whole day off-peak</option>
            </select>
          </Field>
          <Field label={`Walk-in hold-back: ${cfg.holdbackPct}%`} hint="Share of game-zone seats kept off the online calendar at peak, released 2 h before">
            <input type="range" min={0} max={50} step={5} value={cfg.holdbackPct} onChange={(e) => setCfg({ ...cfg, holdbackPct: Number(e.target.value) })} className="w-full" />
          </Field>
          <Field label="Deep clean" hint="30 min default; moving it to opening frees a sellable hour">
            <div className="flex gap-2">
              <input
                type="time"
                className="input"
                value={cfg.deepCleanStart == null ? "" : toTime(cfg.deepCleanStart)}
                onChange={(e) => setCfg({ ...cfg, deepCleanStart: e.target.value ? fromTime(e.target.value) : null })}
              />
              <select className="input w-auto" value={cfg.deepCleanZone} onChange={(e) => setCfg({ ...cfg, deepCleanZone: e.target.value as "game" | "splatter" })}>
                <option value="game">Game zone</option>
                <option value="splatter">Splatter zone</option>
              </select>
              <button className="btn btn-sm" onClick={() => setCfg({ ...cfg, deepCleanStart: null })}>
                None
              </button>
            </div>
          </Field>
          <Field label="Pre-flag Rotation Hours (All-5 only)" hint="Hours otherwise convert on demand when the first All-5 booking lands">
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: Math.ceil((cfg.closeMin - cfg.openMin) / 60) }, (_, i) => Math.floor(cfg.openMin / 60) + i).map((h) => {
                const on = cfg.rotationHours.includes(h);
                return (
                  <button key={h} className={`btn btn-sm ${on ? "border-fuchsia-400 text-fuchsia-300" : ""}`} onClick={() => setCfg({ ...cfg, rotationHours: on ? cfg.rotationHours.filter((x) => x !== h) : [...cfg.rotationHours, h].sort((a, b) => a - b) })}>
                    {fmtMin(h * 60)}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="All 5 games policy" hint="§3.3: 5 × 12 min in one Rotation Hour (catalogue promise), or 5 × 20 min (100 min) on the normal grid">
            <select className="input" value={cfg.all5Override ?? "default"} onChange={(e) => setCfg({ ...cfg, all5Override: e.target.value === "default" ? null : (e.target.value as "rotation" | "grid") })}>
              <option value="default">Venue default</option>
              <option value="rotation">Rotation Hours (1 hr)</option>
              <option value="grid">5 × 20 min (100 min)</option>
            </select>
          </Field>
          <div className="flex items-center gap-2 md:col-span-2">
            <button className="btn btn-primary" onClick={() => save(false)}>
              Save {fmtDay(day)}
            </button>
            {cfg.hasOverride && (
              <button className="btn" onClick={() => save(true)}>
                Reset to defaults
              </button>
            )}
            {msg && <span className="text-sm text-lime">{msg}</span>}
          </div>
          <div className="md:col-span-2">
            <ErrorNote error={err} />
          </div>
        </div>
      )}
      <DayBlocks day={day} />
      {atLeast(staff, "owner") && <VenueDefaults />}
    </div>
  );
}

function VenueDefaults() {
  const [v, setV] = useState<{ openMin: number; closeMin: number; holdbackPct: number; deepCleanStart: number | null; deepCleanMin: number; deepCleanZone: "game" | "splatter"; all5Mode: "rotation" | "grid" } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api<typeof v>("/api/settings").then(setV);
  }, []);
  if (!v) return null;
  return (
    <div className="card space-y-3">
      <div className="text-sm font-semibold">Venue defaults (every day without an override)</div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Open">
          <input type="time" className="input" value={toTime(v.openMin)} onChange={(e) => setV({ ...v, openMin: fromTime(e.target.value) })} />
        </Field>
        <Field label="Close">
          <input type="time" className="input" value={toTime(v.closeMin)} onChange={(e) => setV({ ...v, closeMin: fromTime(e.target.value) })} />
        </Field>
        <Field label="Hold-back %">
          <input type="number" className="input w-24" value={v.holdbackPct} onChange={(e) => setV({ ...v, holdbackPct: Number(e.target.value) })} />
        </Field>
        <Field label="Deep clean">
          <input type="time" className="input" value={v.deepCleanStart == null ? "" : toTime(v.deepCleanStart)} onChange={(e) => setV({ ...v, deepCleanStart: e.target.value ? fromTime(e.target.value) : null })} />
        </Field>
        <Field label="All 5 games">
          <select className="input" value={v.all5Mode} onChange={(e) => setV({ ...v, all5Mode: e.target.value as "rotation" | "grid" })}>
            <option value="rotation">Rotation Hours (1 hr)</option>
            <option value="grid">5 × 20 min (100 min)</option>
          </select>
        </Field>
        <button
          className="btn btn-primary"
          onClick={async () => {
            await api("/api/settings", { method: "PUT", body: v });
            setMsg("Saved");
          }}
        >
          Save defaults
        </button>
        {msg && <span className="text-sm text-lime">{msg}</span>}
      </div>
    </div>
  );
}

/** §6/§9 manual CalendarBlocks: staff breaks per roster, maintenance, private holds. Capacity-zero. */
function DayBlocks({ day }: { day: string }) {
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [blocks, setBlocks] = useState<ManualBlock[] | null>(null);
  const [form, setForm] = useState({ rooms: [] as string[], start: "15:00", end: "15:20", kind: "Staff break", note: "" });
  const [err, setErr] = useState<string | null>(null);
  const [v, setV] = useState(0);

  useEffect(() => {
    api<{ rooms: RoomRow[] }>("/api/products").then((d) => setRooms(d.rooms ?? []));
  }, []);
  useEffect(() => {
    api<{ blocks: ManualBlock[] }>(`/api/blocks?date=${day}`).then((d) => setBlocks(d.blocks));
  }, [day, v]);

  async function add() {
    setErr(null);
    try {
      await api("/api/blocks", { body: { date: day, rooms: form.rooms, startMin: fromTime(form.start), endMin: fromTime(form.end), kind: form.kind, note: form.note } });
      setV((x) => x + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function remove(id: number) {
    await api(`/api/blocks/${id}`, { method: "DELETE" });
    setV((x) => x + 1);
  }
  const roomName = (id: string) => rooms.find((r) => r.id === id)?.name ?? id;

  return (
    <div className="card space-y-3">
      <div className="font-semibold">Room blocks for {fmtDay(day)}</div>
      <p className="text-sm text-muted">Staff breaks, maintenance and private holds. A blocked room sells 0 seats; you can only block time with no booked guests in it. Paint cleanups, the deep clean and party setup are added automatically.</p>
      {!blocks ? (
        <Spinner />
      ) : blocks.length === 0 ? (
        <div className="text-sm text-muted">No manual blocks.</div>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {blocks.map((b) => (
              <tr key={b.id} className="border-t border-line">
                <td className="py-1.5">{roomName(b.room_id)}</td>
                <td className="font-mono">
                  {fmtMin(b.start_min)}–{fmtMin(b.end_min)}
                </td>
                <td>{b.reason}</td>
                <td className="text-xs text-muted">{b.created_by}</td>
                <td className="text-right">
                  <button className="btn btn-sm btn-danger" onClick={() => remove(b.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="space-y-2 border-t border-line pt-3">
        <div className="flex flex-wrap gap-1">
          {rooms.map((r) => {
            const on = form.rooms.includes(r.id);
            return (
              <button key={r.id} className={`btn btn-sm ${on ? "border-cyan text-cyan" : ""}`} onClick={() => setForm({ ...form, rooms: on ? form.rooms.filter((x) => x !== r.id) : [...form.rooms, r.id] })}>
                {r.name}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="From">
            <input type="time" step={300} className="input" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="time" step={300} className="input" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
          </Field>
          <Field label="Type">
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {["Staff break", "Maintenance", "Private hold", "Other"].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
          <Field label="Note">
            <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. Ravi lunch" />
          </Field>
          <button className="btn btn-primary" disabled={form.rooms.length === 0} onClick={add}>
            Add block
          </button>
        </div>
        <ErrorNote error={err} />
      </div>
    </div>
  );
}
