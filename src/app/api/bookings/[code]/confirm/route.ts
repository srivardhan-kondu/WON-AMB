import { z } from "zod";
import { bookingAccess } from "@/lib/access";
import { handlePaymentCaptured, holdResultFor } from "@/lib/bookings";
import { HttpError, body, handle, json } from "@/lib/http";
import { payments } from "@/lib/payments";
import { db } from "@/lib/db";

const C = z.object({ t: z.string(), razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() });

/** Polling fallback after Checkout returns; the signed webhook remains the primary confirmer. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ code: string }> }) => {
  const { code } = await ctx.params;
  const c = await body(req, C);
  const { booking } = await bookingAccess(code, { t: c.t });
  const pay = await db().prepare("SELECT 1 FROM payments WHERE booking_id = ? AND provider_order_id = ?").get(booking.id, c.razorpay_order_id);
  if (!pay) throw new HttpError(400, "Order does not belong to this booking");
  if (!payments().verifyCheckout(c.razorpay_order_id, c.razorpay_payment_id, c.razorpay_signature)) throw new HttpError(400, "Payment signature invalid");
  const r = await handlePaymentCaptured(c.razorpay_order_id, c.razorpay_payment_id, null, { via: "checkout" });
  return json({ ...r, ...(await holdResultFor(booking.code)) });
});
