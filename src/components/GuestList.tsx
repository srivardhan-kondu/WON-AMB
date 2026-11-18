"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { AGE_BANDS } from "@/lib/waiver";

type Guest = { name: string; ageBand?: string };

/** §6: the group leader edits the guest list until check-in, without touching the schedule. */
export function GuestList({ code, token, party, guests, editable, onSaved }: { code: string; token: string | null; party: number; guests: Guest[]; editable: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Guest[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function start() {
    setRows(Array.from({ length: party }, (_, i) => guests[i] ?? { name: "" }));
    setErr(null);
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/bookings/${code}/guests?t=${encodeURIComponent(token ?? "")}`, { method: "PUT", body: { guests: rows.filter((g) => g.name.trim()) } });
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">Guest list</div>
          <div className="text-sm text-muted">
            {guests.length} of {party} named{editable ? " · editable until check-in" : ""}
          </div>
        </div>
        {editable && !editing && (
          <button className="btn btn-sm" onClick={start}>
            Edit guests
          </button>
        )}
      </div>
      {!editing ? (
        guests.length > 0 && (
          <ul className="space-y-1 text-sm">
            {guests.map((g, i) => (
              <li key={i} className="flex justify-between">
                <span>{g.name}</span>
                <span className="text-muted">{g.ageBand ?? ""}</span>
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className="space-y-2">
          {rows.map((g, i) => (
            <div key={i} className="flex gap-2">
              <input className="input flex-1" placeholder={`Guest ${i + 1} name`} value={g.name} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
              <select className="input w-40" value={g.ageBand ?? ""} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, ageBand: e.target.value || undefined } : r)))}>
                <option value="">Age band</option>
                {AGE_BANDS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <p className="text-xs text-muted">Changing names doesn&apos;t change your slot or price. To add or remove guests, ask the front desk.</p>
          {err && <div className="text-sm text-red">{err}</div>}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={save}>
              Save guest list
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
