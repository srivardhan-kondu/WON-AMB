import { handlePaymentCaptured, handlePaymentFailed } from "@/lib/bookings";
import { handle, json } from "@/lib/http";
import { payments } from "@/lib/payments";

interface RzpEvent {
  event: string;
  payload?: { payment?: { entity?: { id: string; order_id: string; amount: number } } };
}

/** Trusts only signed events. payment.captured → confirm under the day lock; payment.failed → release hold. */
export const POST = handle(async (req: Request) => {
  const raw = await req.text();
  const p = payments();
  if (p.name !== "razorpay" || !p.verifyWebhook(raw, req.headers.get("x-razorpay-signature"))) return json({ error: "bad signature" }, 401);
  const ev = JSON.parse(raw) as RzpEvent;
  const pay = ev.payload?.payment?.entity;
  if (!pay) return json({ ok: true, ignored: true });
  if (ev.event === "payment.captured") return json(await handlePaymentCaptured(pay.order_id, pay.id, pay.amount, ev));
  if (ev.event === "payment.failed") {
    await handlePaymentFailed(pay.order_id);
    return json({ ok: true });
  }
  return json({ ok: true, ignored: ev.event });
});
