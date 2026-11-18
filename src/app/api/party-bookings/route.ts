import { z } from "zod";
import { normalizePhone, requireStaff } from "@/lib/auth";
import { createHold } from "@/lib/bookings";
import { HttpError, body, handle, json } from "@/lib/http";
import { getProduct } from "@/lib/repo";
import { approveOverride } from "@/lib/override";

const P = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  product: z.string(),
  party: z.number().int().min(1).max(40),
  start: z.number().int(),
  name: z.string().trim().min(1),
  phone: z.string(),
  food: z.boolean().default(false),
  notes: z.string().max(500).default(""),
  payment: z.enum(["online", "cash", "upi_counter"]),
  overrideLead: z.boolean().default(false),
  managerPin: z.string().optional(),
});

/** Party quote → exclusive zone block + setup/teardown → 25% deposit (link or counter). */
export const POST = handle(async (req: Request) => {
  const staff = await requireStaff("desk");
  const p = await body(req, P);
  if ((await getProduct(p.product))?.shape !== "party") throw new HttpError(400, "Not a party product");
  const approver = p.overrideLead ? await approveOverride(req, staff, p.managerPin, "party_48h_override") : null;
  const res = await createHold({
    day: p.date, productId: p.product, party: p.party, start: p.start, name: p.name, phone: normalizePhone(p.phone),
    source: "desk", payment: p.payment, food: p.food, notes: approver ? `${p.notes} [48 h rule overridden by ${approver}]`.trim() : p.notes, actor: staff.email, overridePartyLead: p.overrideLead,
    idemKey: req.headers.get("idempotency-key"),
  });
  return json(res, 201);
});
