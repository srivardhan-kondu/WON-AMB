"use client";

import { useEffect, useState } from "react";
import { StaffShell } from "@/components/StaffShell";
import { CheckIn } from "@/components/desk/CheckIn";
import { PartyDesk } from "@/components/desk/PartyDesk";
import { TodayBoard } from "@/components/desk/TodayBoard";
import { WalkIn } from "@/components/desk/WalkIn";
import { StatusChip } from "@/components/ui";
import type { Product, Room } from "@/lib/engine/types";
import { api } from "@/lib/client";
import { fmtMin, todayIST } from "@/lib/time";

const TABS = ["Today", "Walk-in", "Check-in", "Party", "Waitlist"] as const;

export default function DeskPage() {
  return (
    <StaffShell min="desk">
      <Desk />
    </StaffShell>
  );
}

function Desk() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Today");
  const [products, setProducts] = useState<Product[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [checkinCode, setCheckinCode] = useState<string | undefined>();

  useEffect(() => {
    api<{ products: Product[] }>("/api/admin/products").then((d) => setProducts(d.products));
    api<{ rooms: Room[] }>("/api/products").then((d) => setRooms(d.rooms));
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? "tab-active" : ""}`} onClick={() => { setTab(t); if (t !== "Check-in") setCheckinCode(undefined); }}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Today" && <TodayBoard onCheckIn={(c) => { setCheckinCode(c); setTab("Check-in"); }} />}
      {tab === "Walk-in" && <WalkIn products={products} rooms={rooms} />}
      {tab === "Check-in" && <CheckIn initial={checkinCode} />}
      {tab === "Party" && <PartyDesk products={products} />}
      {tab === "Waitlist" && <Waitlist products={products} />}
    </div>
  );
}

function Waitlist({ products }: { products: Product[] }) {
  const [day, setDay] = useState(todayIST());
  const [rows, setRows] = useState<{ id: number; hour: number; product_id: string; party_size: number; state: string; offer_start: number | null; name: string; phone: string }[]>([]);
  useEffect(() => {
    api<{ entries: typeof rows }>(`/api/desk/waitlist?date=${day}`).then((d) => setRows(d.entries));
  }, [day]);
  return (
    <div className="space-y-3">
      <input type="date" className="input w-auto" value={day} onChange={(e) => setDay(e.target.value)} />
      <div className="overflow-hidden rounded-2xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-panel text-left text-xs uppercase text-muted">
            <tr>
              <th className="px-3 py-2">Hour</th>
              <th className="px-3 py-2">Guest</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Party</th>
              <th className="px-3 py-2">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="px-3 py-2 font-mono">{fmtMin(r.hour * 60)}</td>
                <td className="px-3 py-2">
                  {r.name} <span className="text-xs text-muted">{r.phone}</span>
                </td>
                <td className="px-3 py-2">{products.find((p) => p.id === r.product_id)?.name ?? r.product_id}</td>
                <td className="px-3 py-2">{r.party_size}</td>
                <td className="px-3 py-2">
                  <StatusChip status={r.state} /> {r.offer_start != null && <span className="text-xs text-muted">offered {fmtMin(r.offer_start)}</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted">
                  Nobody waiting.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
