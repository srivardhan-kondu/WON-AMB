"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DESK_TABS, StaffShell, useTab } from "@/components/StaffShell";
import { CheckIn } from "@/components/desk/CheckIn";
import { PartyDesk } from "@/components/desk/PartyDesk";
import { TodayBoard } from "@/components/desk/TodayBoard";
import { WalkIn } from "@/components/desk/WalkIn";
import { StatusChip } from "@/components/ui";
import type { Product, Room } from "@/lib/engine/types";
import { api } from "@/lib/client";
import { fmtMin, todayIST } from "@/lib/time";

export default function DeskPage() {
  return (
    <StaffShell min="desk">
      <Desk />
    </StaffShell>
  );
}

function Desk() {
  const tab = useTab(DESK_TABS);
  const router = useRouter();
  const checkinCode = useSearchParams().get("code") ?? undefined;
  const [products, setProducts] = useState<Product[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const goCheckIn = (code: string) => router.push(`/desk?tab=checkin&code=${encodeURIComponent(code)}`);

  useEffect(() => {
    api<{ products: Product[] }>("/api/admin/products").then((d) => setProducts(d.products));
    api<{ rooms: Room[] }>("/api/products").then((d) => setRooms(d.rooms));
  }, []);

  return (
    <div className="space-y-4">
      {tab === "today" && <TodayBoard onCheckIn={goCheckIn} />}
      {tab === "walkin" && <WalkIn products={products} rooms={rooms} onCheckIn={goCheckIn} />}
      {tab === "checkin" && <CheckIn key={checkinCode ?? ""} initial={checkinCode} />}
      {tab === "party" && <PartyDesk products={products} />}
      {tab === "waitlist" && <Waitlist products={products} />}
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
      <div className="table-wrap">
        <table className="data-table">
          <thead>
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
              <tr key={r.id}>
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
