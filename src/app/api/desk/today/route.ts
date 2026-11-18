import type { NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { sweep } from "@/lib/bookings";
import { db } from "@/lib/db";
import { HttpError, handle, json } from "@/lib/http";
import { listProducts } from "@/lib/repo";
import { isValidDay, todayIST } from "@/lib/time";

/** Today board: every booking by start time with status chips. */
export const GET = handle(async (req: NextRequest) => {
  await requireStaff("desk");
  sweep(true);
  const day = req.nextUrl.searchParams.get("date") || todayIST();
  if (!isValidDay(day)) throw new HttpError(400, "Bad date");
  const products = new Map(listProducts(true).map((p) => [p.id, p.name]));
  const rows = db()
    .prepare(
      `SELECT b.code, b.product_id, b.start_min, b.end_min, b.party_size, b.status, b.source, b.price_paise, b.paid_paise, b.payment_method,
              b.hold_expires, b.food, b.notes, b.reschedule_count, c.name, c.phone,
              (SELECT COUNT(*) FROM waivers w WHERE w.booking_id = b.id) AS waivers,
              (SELECT GROUP_CONCAT(r.name, ' → ') FROM booking_legs l JOIN rooms r ON r.id = l.room_id WHERE l.booking_id = b.id) AS rooms
       FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
       WHERE b.day = ? AND b.status NOT IN ('expired')
       ORDER BY b.start_min, b.id`,
    )
    .all(day) as Record<string, unknown>[];
  return json({ day, bookings: rows.map((r) => ({ ...r, product: products.get(String(r.product_id)) ?? r.product_id })) });
});
