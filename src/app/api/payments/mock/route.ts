import { z } from "zod";
import crypto from "node:crypto";
import { handlePaymentCaptured, handlePaymentFailed } from "@/lib/bookings";
import { HttpError, body, handle, json } from "@/lib/http";
import { payments } from "@/lib/payments";

const M = z.object({ orderId: z.string(), outcome: z.enum(["success", "fail"]) });

/** Test-mode gateway: simulates Razorpay's payment.captured / payment.failed webhooks. */
export const POST = handle(async (req: Request) => {
  if (payments().name !== "mock") throw new HttpError(404, "Not found");
  const m = await body(req, M);
  if (!m.orderId.startsWith("mock_order_")) throw new HttpError(400, "Not a mock order");
  if (m.outcome === "fail") {
    handlePaymentFailed(m.orderId);
    return json({ ok: true, failed: true });
  }
  return json(await handlePaymentCaptured(m.orderId, "mock_pay_" + crypto.randomBytes(6).toString("hex"), null, { mock: true }));
});
