import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { markNoShow } from "@/lib/bookings";
import { body, handle, json } from "@/lib/http";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ code: string }> }) => {
  const staff = await requireStaff("desk");
  const { reason } = await body(req, z.object({ reason: z.string().max(200).default("manual") }));
  await markNoShow((await ctx.params).code, staff.email, reason);
  return json({ ok: true });
});
