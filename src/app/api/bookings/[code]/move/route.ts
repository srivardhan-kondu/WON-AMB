import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { reschedule } from "@/lib/bookings";
import { body, handle, json } from "@/lib/http";
import { approveOverride } from "@/lib/override";

/** Staff reschedule. Without a PIN the customer rules apply; with a manager PIN they're overridden (audited). */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ code: string }> }) => {
  const staff = await requireStaff("desk");
  const m = await body(req, z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start: z.number().int(), reason: z.string().max(200).optional(), managerPin: z.string().optional() }));
  const { code } = await ctx.params;
  const approver = m.managerPin ? await approveOverride(req, staff, m.managerPin, `move:${code}`) : null;
  await reschedule(code, m.date, m.start, staff.email, { override: !!approver, reason: approver ? `${m.reason ?? ""} (approved by ${approver})`.trim() : m.reason });
  return json({ ok: true });
});
