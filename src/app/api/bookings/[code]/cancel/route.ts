import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { cancelBooking } from "@/lib/bookings";
import { body, handle, json } from "@/lib/http";
import { approveOverride } from "@/lib/override";

/** Override: needs a manager PIN (re-auth at the counter). Audited with reason and approver. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ code: string }> }) => {
  const staff = await requireStaff("desk");
  const { reason, managerPin } = await body(req, z.object({ reason: z.string().trim().min(3).max(200), managerPin: z.string().optional() }));
  const { code } = await ctx.params;
  const approver = await approveOverride(req, staff, managerPin, `cancel:${code}`);
  await cancelBooking(code, staff.email, `${reason} (approved by ${approver})`);
  return json({ ok: true });
});
