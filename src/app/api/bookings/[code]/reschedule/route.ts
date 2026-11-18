import { z } from "zod";
import { getCustomerPhone } from "@/lib/auth";
import { quoteDay, reschedule } from "@/lib/bookings";
import { db } from "@/lib/db";
import { HttpError, body, handle, json } from "@/lib/http";
import { getBookingByCode } from "@/lib/repo";
import { roomNames } from "@/lib/access";

const R = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start: z.number().int().nullish() });

/** One free move ≥ 24 h ahead, equal-value slots only. Requires OTP login. Without `start`, returns options. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ code: string }> }) => {
  const { code } = await ctx.params;
  const r = await body(req, R);
  const phone = await getCustomerPhone();
  if (!phone) throw new HttpError(401, "Verify your phone first");
  const b = await getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  const c = await db().prepare("SELECT phone FROM customers WHERE id = ?").get(b.customer_id) as { phone: string } | undefined;
  if (!c || c.phone !== phone) throw new HttpError(403, "This booking belongs to a different phone number");
  if (r.start == null) {
    const { result } = await quoteDay({ day: r.date, productId: b.product_id, party: b.party_size, channel: "online", excludeBookingId: b.id, preferredMin: b.start_min, limit: 8 });
    const names = await roomNames();
    return json({
      offers: result.offers
        .filter((o) => !(r.date === b.day && o.start === b.start_min))
        .map((o) => ({ ...o, legs: o.legs.map((l) => ({ ...l, room: names.get(l.roomId) })) })),
    });
  }
  await reschedule(b.code, r.date, r.start, "customer", { override: false });
  return json({ ok: true });
});
