import { z } from "zod";
import { createHold } from "@/lib/bookings";
import { normalizePhone } from "@/lib/auth";
import { body, handle, json, rateLimit } from "@/lib/http";

const H = z.object({
  product: z.string(),
  party: z.number().int().min(1).max(40),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.number().int().min(0).max(1440),
  chosenRooms: z.array(z.string()).max(5).nullish(),
  name: z.string().trim().min(1).max(80),
  phone: z.string().min(10).max(16),
  guestNames: z.array(z.string().max(80)).max(40).optional(),
});

/** Lock an offer for 10 minutes and open a payment order. Idempotent on the Idempotency-Key header. */
export const POST = handle(async (req: Request) => {
  rateLimit(req, "holds", 20);
  const h = await body(req, H);
  const res = await createHold({
    day: h.date, productId: h.product, party: h.party, start: h.start, chosenRooms: h.chosenRooms,
    name: h.name, phone: normalizePhone(h.phone), source: "online", payment: "online",
    idemKey: req.headers.get("idempotency-key"), guestNames: h.guestNames, actor: "customer",
  });
  return json(res, 201);
});
