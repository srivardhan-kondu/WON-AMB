"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DESK_TABS, StaffShell, useTab } from "@/components/StaffShell";
import { CheckIn } from "@/components/desk/CheckIn";
import { PartyDesk } from "@/components/desk/PartyDesk";
import { TodayBoard } from "@/components/desk/TodayBoard";
import { WalkIn } from "@/components/desk/WalkIn";
import type { Product, Room } from "@/lib/engine/types";
import { api } from "@/lib/client";

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
    </div>
  );
}
