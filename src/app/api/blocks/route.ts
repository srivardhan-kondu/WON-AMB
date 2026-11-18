import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { emitChange } from "@/lib/events";
import { HttpError, body, handle, json } from "@/lib/http";
import { audit, buildLedger, listRooms } from "@/lib/repo";
import { isValidDay } from "@/lib/time";

/** Manual calendar blocks (§6/§9): staff breaks per roster, maintenance, private holds. */
export const GET = handle(async (req: NextRequest) => {
  await requireStaff("desk");
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!isValidDay(date)) throw new HttpError(400, "Bad date");
  const rows = db()
    .prepare("SELECT id, room_id, start_min, end_min, reason, created_by FROM calendar_blocks WHERE day = ? AND booking_id IS NULL ORDER BY start_min, room_id")
    .all(date);
  return json({ blocks: rows });
});

const B = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rooms: z.array(z.string()).min(1),
  startMin: z.number().int().min(0).max(1440),
  endMin: z.number().int().min(1).max(1440),
  kind: z.enum(["Staff break", "Maintenance", "Private hold", "Other"]),
  note: z.string().trim().max(120).default(""),
});

/**
 * Blocks are capacity-zero (§6), so one can only be placed on time that is free in every chosen room:
 * an existing booking is never silently stranded. Placed under the day lock like any commit.
 */
export const POST = handle(async (req: Request) => {
  const staff = await requireStaff("manager");
  const b = await body(req, B);
  if (!isValidDay(b.date)) throw new HttpError(400, "Bad date");
  if (b.endMin <= b.startMin) throw new HttpError(400, "End must be after start");
  if (b.endMin - b.startMin > 12 * 60) throw new HttpError(400, "A block can be at most 12 hours");
  const known = new Set(listRooms().map((r) => r.id));
  if (b.rooms.some((r) => !known.has(r))) throw new HttpError(400, "Unknown room");
  const reason = b.note ? `${b.kind}: ${b.note}` : b.kind;
  const d = db();
  const ids = d
    .transaction(() => {
      const ledger = buildLedger(b.date);
      const busy = b.rooms.filter((r) => {
        for (let m = b.startMin; m < b.endMin; m++) if (ledger.occAt(r, m) > 0) return true;
        return false;
      });
      if (busy.length) throw new HttpError(409, `Booked guests are in ${busy.join(", ")} during that time — move them first`);
      const ins = d.prepare("INSERT INTO calendar_blocks (room_id, day, start_min, end_min, reason, booking_id, created_by) VALUES (?, ?, ?, ?, ?, NULL, ?)");
      return b.rooms.map((r) => Number(ins.run(r, b.date, b.startMin, b.endMin, reason, staff.email).lastInsertRowid));
    })
    .immediate();
  audit(staff.email, "calendar_block_added", b.date, { ...b, ids });
  emitChange(b.date);
  return json({ ids }, 201);
});
