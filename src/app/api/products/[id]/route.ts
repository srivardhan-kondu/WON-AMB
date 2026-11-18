import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, body, handle, json } from "@/lib/http";
import { audit, getProduct } from "@/lib/repo";

const P = z.object({
  pricePaise: z.number().int().min(0).max(10_000_000),
  extraPaise: z.number().int().min(0).max(10_000_000).optional(),
  active: z.boolean(),
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().max(200).optional(),
  minParty: z.number().int().min(1).max(40).optional(),
  maxParty: z.number().int().min(1).max(40).optional(),
});

/** Prices and activation — owner only, every change audited. Existing bookings keep the price they paid. */
export const PUT = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const staff = await requireStaff("owner");
  const { id } = await ctx.params;
  const before = getProduct(id);
  if (!before) throw new HttpError(404, "Unknown product");
  const p = await body(req, P);
  if ((p.minParty ?? before.minParty) > (p.maxParty ?? before.maxParty)) throw new HttpError(400, "Min party exceeds max party");
  db().prepare(
    "UPDATE products SET price_paise = ?, extra_paise = ?, active = ?, name = ?, description = ?, min_party = ?, max_party = ? WHERE id = ?",
  ).run(p.pricePaise, p.extraPaise ?? before.extraPaise, p.active ? 1 : 0, p.name ?? before.name, p.description ?? before.description, p.minParty ?? before.minParty, p.maxParty ?? before.maxParty, id);
  audit(staff.email, "product_updated", `product:${id}`, { before: { price: before.pricePaise, active: before.active }, after: p });
  return json(getProduct(id));
});
