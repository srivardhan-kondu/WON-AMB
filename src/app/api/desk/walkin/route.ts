import { z } from "zod";
import { normalizePhone, requireStaff } from "@/lib/auth";
import { activeMembership, createHold } from "@/lib/bookings";
import { HttpError, body, handle, json } from "@/lib/http";
import { todayIST } from "@/lib/time";
import { approveOverride } from "@/lib/override";

const W = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  product: z.string(),
  party: z.number().int().min(1).max(40),
  start: z.number().int(),
  chosenRooms: z.array(z.string()).nullish(),
  name: z.string().trim().min(1).max(80),
  phone: z.string(),
  payment: z.enum(["cash", "upi_counter", "online", "membership", "comp"]),
  source: z.enum(["desk", "phone"]).default("desk"),
  reason: z.string().max(200).optional(),
  managerPin: z.string().optional(),
});

/** Walk-in / phone booking: same quote pipeline, counter payment. Comp tickets need a manager. */
export const POST = handle(async (req: Request) => {
  const staff = await requireStaff("desk");
  const w = await body(req, W);
  let approver: string | null = null;
  if (w.payment === "comp") {
    if (!w.reason) throw new HttpError(400, "Give a reason for the comp ticket");
    approver = approveOverride(req, staff, w.managerPin, "comp_ticket");
  }
  const phone = normalizePhone(w.phone);
  const day = w.date ?? todayIST();
  const m = w.payment === "membership" ? activeMembership(phone, day) : undefined;
  const res = await createHold({
    day, productId: w.product, party: w.party, start: w.start, chosenRooms: w.chosenRooms, name: w.name, phone,
    source: w.source, payment: w.payment, idemKey: req.headers.get("idempotency-key"), actor: staff.email,
    membershipId: m?.id ?? null, notes: approver ? `comp: ${w.reason} (approved by ${approver})` : undefined,
  });
  return json(res, 201);
});
