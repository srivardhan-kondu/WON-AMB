import { z } from "zod";
import { joinWaitlist } from "@/lib/bookings";
import { normalizePhone } from "@/lib/auth";
import { body, handle, json, rateLimit } from "@/lib/http";

const W = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hour: z.number().int().min(0).max(23),
  product: z.string(),
  party: z.number().int().min(1).max(12),
  name: z.string().trim().min(1).max(80),
  phone: z.string(),
});

export const POST = handle(async (req: Request) => {
  rateLimit(req, "waitlist", 10);
  const w = await body(req, W);
  return json(joinWaitlist({ day: w.date, hour: w.hour, productId: w.product, party: w.party, phone: normalizePhone(w.phone), name: w.name }), 201);
});
