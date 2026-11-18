import { cookies } from "next/headers";
import { CUSTOMER_COOKIE, bookingToken, getCustomerPhone } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, handle, json } from "@/lib/http";
import { todayIST } from "@/lib/time";

/** Customer view after phone OTP (§9): memberships with visits left, and upcoming bookings. */
export const GET = handle(async () => {
  const phone = await getCustomerPhone();
  if (!phone) throw new HttpError(401, "Verify your phone first");
  const d = db();
  const c = d.prepare("SELECT id, name FROM customers WHERE phone = ?").get(phone) as { id: number; name: string } | undefined;
  if (!c) return json({ name: "", phoneMasked: mask(phone), memberships: [], bookings: [] });
  const memberships = d
    .prepare(
      `SELECT m.id, m.plan, m.valid_till, m.visits_left, (SELECT COUNT(*) FROM membership_visits v WHERE v.membership_id = m.id) AS used
       FROM memberships m WHERE m.customer_id = ? ORDER BY m.valid_till DESC`,
    )
    .all(c.id) as { id: number; plan: string; valid_till: string; visits_left: number | null; used: number }[];
  const visits = d.prepare(
    `SELECT b.code, b.day, b.start_min, p.name AS product FROM membership_visits v JOIN bookings b ON b.id = v.booking_id JOIN products p ON p.id = b.product_id
     WHERE v.membership_id = ? ORDER BY v.used_at DESC LIMIT 10`,
  );
  const today = todayIST();
  const bookings = (d
    .prepare(
      `SELECT b.code, b.day, b.start_min, b.party_size, b.status, p.name AS product FROM bookings b JOIN products p ON p.id = b.product_id
       WHERE b.customer_id = ? AND b.day >= ? AND b.status IN ('hold','confirmed','arrived') ORDER BY b.day, b.start_min LIMIT 20`,
    )
    .all(c.id, today) as { code: string; day: string; start_min: number; party_size: number; status: string; product: string }[]).map((b) => ({ ...b, token: bookingToken(b.code) }));
  return json({
    name: c.name,
    phoneMasked: mask(phone),
    memberships: memberships.map((m) => ({ ...m, active: m.valid_till >= today && (m.visits_left == null || m.visits_left > 0), recent: visits.all(m.id) })),
    bookings,
  });
});

/** Sign out (drops the OTP session cookie). */
export const DELETE = handle(async () => {
  (await cookies()).delete(CUSTOMER_COOKIE);
  return json({ ok: true });
});

function mask(p: string) {
  return p.slice(0, 3) + "•••••" + p.slice(-3);
}
