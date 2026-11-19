import type { NextRequest } from "next/server";
import { normalizePhone, requireStaff } from "@/lib/auth";
import { activeMembership } from "@/lib/bookings";
import { db } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { todayIST } from "@/lib/time";

/** Front-desk lookup by mobile number: a returning guest's name and active membership, so the desk doesn't retype them. */
export const GET = handle(async (req: NextRequest) => {
  await requireStaff("desk");
  const raw = req.nextUrl.searchParams.get("phone") ?? "";
  if (raw.replace(/\D/g, "").length < 10) return json({ name: null, visits: 0, membership: null });
  const phone = normalizePhone(raw);
  const c = await db()
    .prepare("SELECT c.name, (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id AND b.status IN ('confirmed','arrived','done')) AS visits FROM customers c WHERE c.phone = ?")
    .get<{ name: string | null; visits: number }>(phone);
  const m = await activeMembership(phone, todayIST());
  return json({
    name: c?.name || null,
    visits: Number(c?.visits ?? 0),
    membership: m ? { plan: m.plan, visits_left: m.visits_left, valid_till: m.valid_till } : null,
  });
});
