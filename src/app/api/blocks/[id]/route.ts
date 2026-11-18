import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { emitChange } from "@/lib/events";
import { HttpError, handle, json } from "@/lib/http";
import { audit } from "@/lib/repo";

/** Remove a manual block (built-in cleanups and party blocks are not removable here). */
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const staff = await requireStaff("manager");
  const id = Number((await ctx.params).id);
  const d = db();
  const row = await d.prepare("SELECT * FROM calendar_blocks WHERE id = ? AND booking_id IS NULL").get(id) as { day: string; room_id: string; start_min: number; end_min: number; reason: string } | undefined;
  if (!row) throw new HttpError(404, "Block not found");
  await d.prepare("DELETE FROM calendar_blocks WHERE id = ?").run(id);
  await audit(staff.email, "calendar_block_removed", row.day, row);
  emitChange(row.day);
  return json({ ok: true });
});
