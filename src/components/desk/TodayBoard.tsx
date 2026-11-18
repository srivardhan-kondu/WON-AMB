"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusChip, ErrorNote } from "@/components/ui";
import { PinDialog } from "@/components/PinDialog";
import { api } from "@/lib/client";
import { fmtMin, rupees, todayIST } from "@/lib/time";

export interface BoardRow {
  code: string;
  product: string;
  product_id: string;
  start_min: number;
  end_min: number;
  party_size: number;
  status: string;
  source: string;
  price_paise: number;
  paid_paise: number;
  payment_method: string | null;
  food: number;
  notes: string;
  name: string | null;
  phone: string | null;
  waivers: number;
  rooms: string | null;
}

export function TodayBoard({ onCheckIn }: { onCheckIn: (code: string) => void }) {
  const [day, setDay] = useState(todayIST());
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [pinErr, setPinErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ bookings: BoardRow[] }>(`/api/desk/today?date=${day}`)
      .then((d) => setRows(d.bookings))
      .catch((e: Error) => setErr(e.message));
  }, [day]);

  useEffect(() => {
    load();
    const i = setInterval(load, 15_000);
    return () => clearInterval(i);
  }, [load]);

  async function act(code: string, action: "no-show" | "cancel") {
    if (action === "cancel") {
      setCancelling(code);
      setPinErr(null);
      return;
    }
    const reason = prompt("Reason for no-show (optional):", "manual");
    if (reason == null) return;
    try {
      await api(`/api/bookings/${code}/no-show`, { body: { reason } });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function cancelWithPin(pin: string, reason: string) {
    try {
      await api(`/api/bookings/${cancelling}/cancel`, { body: { reason, managerPin: pin } });
      setCancelling(null);
      load();
    } catch (e) {
      setPinErr((e as Error).message);
    }
  }

  const shown = rows.filter((r) => !filter || `${r.code} ${r.name} ${r.phone}`.toLowerCase().includes(filter.toLowerCase()));
  const counts = rows.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});

  return (
    <div className="space-y-3">
      {cancelling && <PinDialog title={`Cancel ${cancelling} (no refund unless owner-approved)`} needReason onSubmit={cancelWithPin} onClose={() => setCancelling(null)} error={pinErr} />}
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" className="input w-auto" value={day} onChange={(e) => setDay(e.target.value)} />
        <input className="input w-56" placeholder="Search code / name / phone" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="ml-auto flex gap-3 text-xs text-muted">
          {Object.entries(counts).map(([s, n]) => (
            <span key={s}>
              {s.replace("_", "-")}: <b className="text-foreground">{n}</b>
            </span>
          ))}
        </div>
      </div>
      <ErrorNote error={err} />
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-panel text-left text-xs uppercase tracking-wider text-muted">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Guest</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Party</th>
              <th className="px-3 py-2">Waivers</th>
              <th className="px-3 py-2">Paid</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.code} className="border-t border-line align-top">
                <td className="px-3 py-2 font-mono">{fmtMin(r.start_min)}</td>
                <td className="px-3 py-2 font-mono">{r.code}</td>
                <td className="px-3 py-2">
                  {r.name || "—"}
                  <div className="text-xs text-muted">{r.phone}</div>
                </td>
                <td className="px-3 py-2">
                  {r.product}
                  <div className="max-w-[220px] truncate text-xs text-muted" title={r.rooms ?? ""}>
                    {r.rooms}
                  </div>
                  {r.food ? <span className="chip border-amber/50 text-amber">food</span> : null}
                </td>
                <td className="px-3 py-2">{r.party_size}</td>
                <td className={`px-3 py-2 ${r.waivers >= r.party_size ? "text-lime" : "text-amber"}`}>
                  {r.waivers}/{r.party_size}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {rupees(r.paid_paise)}
                  <div className="text-muted">{r.payment_method}</div>
                </td>
                <td className="px-3 py-2">
                  <StatusChip status={r.status} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {(r.status === "confirmed" || r.status === "no_show") && day === todayIST() && (
                    <button className="btn btn-sm btn-cyan mr-1" onClick={() => onCheckIn(r.code)}>
                      Check in
                    </button>
                  )}
                  {r.status === "confirmed" && (
                    <button className="btn btn-sm mr-1" onClick={() => act(r.code, "no-show")}>
                      No-show
                    </button>
                  )}
                  {(r.status === "confirmed" || r.status === "hold") && (
                    <button className="btn btn-sm btn-danger" onClick={() => act(r.code, "cancel")}>
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-muted">
                  No bookings{filter ? " match" : " yet"}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
