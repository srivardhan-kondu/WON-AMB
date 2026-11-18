import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, handle, json } from "@/lib/http";
import { audit } from "@/lib/repo";

/** Closing a flash offer affects new quotes only; bookings already sold keep their price. */
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const staff = await requireStaff("manager");
  const id = Number((await ctx.params).id);
  const row = await db().prepare("SELECT * FROM flash_offers WHERE id = ?").get(id);
  if (!row) throw new HttpError(404, "Not found");
  await db().prepare("DELETE FROM flash_offers WHERE id = ?").run(id);
  await audit(staff.email, "flash_offer_closed", `flash:${id}`, row as Record<string, unknown>);
  return json({ ok: true });
});
