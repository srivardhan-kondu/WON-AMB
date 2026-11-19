"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusChip, ErrorNote } from "@/components/ui";
import { PinDialog } from "@/components/PinDialog";
import { Icon } from "@/components/icons";
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
  const [status, setStatus] = useState("all");
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

  function askCancel(code: string) {
    setCancelling(code);
    setPinErr(null);
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

  const STATUS_FILTERS: [string, string, (r: BoardRow) => boolean][] = [
    ["all", "All", (r) => r.status !== "cancelled"],
    ["upcoming", "Upcoming", (r) => r.status === "confirmed"],
    ["arrived", "Checked in", (r) => r.status === "arrived" || r.status === "done"],
    ["hold", "Awaiting payment", (r) => r.status === "hold"],
    ["no_show", "No-show", (r) => r.status === "no_show"],
    ["cancelled", "Cancelled", (r) => r.status === "cancelled"],
  ];
  const statusFn = STATUS_FILTERS.find(([k]) => k === status)?.[2] ?? (() => true);
  const q = filter.trim().toLowerCase();
  const shown = rows.filter((r) => statusFn(r) && (!q || `${r.code} ${r.name} ${r.phone}`.toLowerCase().includes(q)));
  const live = rows.filter((r) => !["cancelled", "expired"].includes(r.status));
  const stats = {
    bookings: live.length,
    guests: live.reduce((n, r) => n + r.party_size, 0),
    arrived: live.filter((r) => r.status === "arrived" || r.status === "done").reduce((n, r) => n + r.party_size, 0),
    waivers: live.filter((r) => r.status === "confirmed" && r.waivers < r.party_size).length,
    collected: live.reduce((n, r) => n + r.paid_paise, 0),
  };

  return (
    <div className="space-y-5">
      {cancelling && <PinDialog title={`Cancel ${cancelling} (no refund unless owner-approved)`} needReason onSubmit={cancelWithPin} onClose={() => setCancelling(null)} error={pinErr} />}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Bookings" value={stats.bookings} />
        <Stat label="Guests expected" value={stats.guests} />
        <Stat label="Guests checked in" value={`${stats.arrived}/${stats.guests}`} tone="lime" />
        <Stat label="Waivers pending" value={stats.waivers} tone={stats.waivers ? "amber" : undefined} hint="bookings not fully signed" />
        <Stat label="Collected" value={rupees(stats.collected)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="tabbar">
          {STATUS_FILTERS.map(([k, label, fn]) => (
            <button key={k} className={`tab ${status === k ? "tab-active" : ""}`} onClick={() => setStatus(k)}>
              {label} <span className="ml-1 text-sm text-muted">{rows.filter(fn).length}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input className="input w-60 pl-8" placeholder="Search code, name or phone" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <input type="date" className="input w-auto" value={day} onChange={(e) => setDay(e.target.value)} />
          <button className="btn" onClick={load} title="Refresh">
            <Icon name="refresh" className="h-4 w-4" />
          </button>
        </div>
      </div>
      <ErrorNote error={err} />
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Guest</th>
              <th>Experience</th>
              <th>Guests</th>
              <th>Payment</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.code}>
                <td className="whitespace-nowrap">
                  <div className="font-semibold">{fmtMin(r.start_min)}</div>
                  <div className="text-sm text-muted">to {fmtMin(r.end_min)}</div>
                </td>
                <td>
                  <div className="font-medium">{r.name || "—"}</div>
                  <div className="whitespace-nowrap text-sm text-muted">
                    <span className="font-mono">{r.code}</span> · {r.phone?.replace(/^\+91/, "")}
                  </div>
                </td>
                <td>
                  <div>{r.product}</div>
                  <div className="max-w-[200px] truncate text-sm text-muted" title={r.rooms ?? ""}>
                    {r.rooms}
                  </div>
                  {r.food ? <span className="chip mt-1 border-amber/20 bg-amber/10 text-amber">food add-on</span> : null}
                </td>
                <td>
                  <WaiverBar signed={r.waivers} party={r.party_size} />
                </td>
                <td className="whitespace-nowrap">
                  <div className="font-medium">{rupees(r.paid_paise)}</div>
                  <div className="text-sm text-muted">{PAY_LABEL[r.payment_method ?? ""] ?? r.payment_method ?? "—"}</div>
                </td>
                <td className="whitespace-nowrap">
                  <StatusChip status={r.status} />
                  <div className="mt-2 flex flex-col gap-1.5 empty:hidden">
                    {(r.status === "confirmed" || r.status === "no_show") && day === todayIST() && (
                      <button className="btn btn-sm btn-cyan" onClick={() => onCheckIn(r.code)}>
                        Check in
                      </button>
                    )}
                    {(r.status === "confirmed" || r.status === "hold") && (
                      <button className="btn btn-sm btn-danger" onClick={() => askCancel(r.code)}>
                        Cancel
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="py-12 text-center text-muted">
                  <Icon name="calendar" className="mx-auto mb-2 h-8 w-8 text-gray-300" />
                  No bookings{filter || status !== "all" ? " match these filters" : " for this day yet"}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const PAY_LABEL: Record<string, string> = { cash: "Cash", upi_counter: "UPI at counter", online: "Online", membership: "Membership", comp: "Complimentary" };

function Stat({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: "lime" | "amber" }) {
  return (
    <div className="stat">
      <div className="text-sm font-medium text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tracking-tight ${tone === "lime" ? "text-lime" : tone === "amber" ? "text-amber" : ""}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

function WaiverBar({ signed, party }: { signed: number; party: number }) {
  const ok = signed >= party;
  return (
    <div className="w-24">
      <div className="font-semibold">
        {party} {party === 1 ? "guest" : "guests"}
      </div>
      <div className={`text-sm font-medium ${ok ? "text-lime" : "text-amber"}`}>
        {Math.min(signed, party)}/{party} waivers
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-2">
        <div className={`h-full rounded-full ${ok ? "bg-lime" : "bg-amber"}`} style={{ width: `${Math.min(100, (signed / Math.max(1, party)) * 100)}%` }} />
      </div>
    </div>
  );
}
