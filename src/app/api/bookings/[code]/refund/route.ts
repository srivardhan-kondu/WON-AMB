import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { refundBooking } from "@/lib/bookings";
import { body, handle, json } from "@/lib/http";
import { approveOverride } from "@/lib/override";

const R = z.object({
  amountPaise: z.number().int().min(1),
  reason: z.string().trim().min(3).max(200),
  cancel: z.boolean().default(false),
  managerPin: z.string().optional(),
});

/** Owner-approved refund exception (§8). Needs the OWNER's PIN, whoever is at the screen. Audited. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ code: string }> }) => {
  const staff = await requireStaff("manager");
  const r = await body(req, R);
  const { code } = await ctx.params;
  const approver = await approveOverride(req, staff, r.managerPin, `refund:${code}`, ["owner"]);
  return json(await refundBooking(code, r.amountPaise, staff.email, approver, r.reason, { cancel: r.cancel }));
});
