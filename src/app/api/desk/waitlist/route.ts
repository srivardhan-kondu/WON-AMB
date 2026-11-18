import type { NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { todayIST } from "@/lib/time";

export const GET = handle(async (req: NextRequest) => {
  await requireStaff("desk");
  const day = req.nextUrl.searchParams.get("date") || todayIST();
  const rows = await db()
    .prepare("SELECT w.id, w.day, w.hour, w.product_id, w.party_size, w.state, w.offer_start, w.offer_expires, c.name, c.phone FROM waitlist w JOIN customers c ON c.id = w.customer_id WHERE w.day = ? ORDER BY w.created_at")
    .all(day);
  return json({ entries: rows });
});
