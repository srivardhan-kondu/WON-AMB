import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { emitChange } from "@/lib/events";
import { HttpError, body, handle, json } from "@/lib/http";
import { audit, buildLedger, getDayConfig } from "@/lib/repo";
import { isValidDay } from "@/lib/time";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ date: string }> }) => {
  await requireStaff("manager");
  const { date } = await ctx.params;
  if (!isValidDay(date)) throw new HttpError(400, "Bad date");
  return json(getDayConfig(date));
});

const D = z.object({
  openMin: z.number().int().min(0).max(1440),
  closeMin: z.number().int().min(0).max(1440),
  peak: z.enum(["auto", "peak", "offpeak"]),
  holdbackPct: z.number().int().min(0).max(80),
  deepCleanStart: z.number().int().min(0).max(1440).nullable(),
  deepCleanMin: z.number().int().min(0).max(120),
  deepCleanZone: z.enum(["game", "splatter"]),
  rotationHours: z.array(z.number().int().min(0).max(23)),
  /** §3.3 rotation-hour policy: All 5 as a 1-hour Rotation Hour, or 5 × 20 min (100 min) on the grid. null = venue default. */
  all5Mode: z.enum(["rotation", "grid"]).nullable().optional(),
  reset: z.boolean().optional(),
});

/** Owner/manager day knobs: hours, peak flag, hold-back, deep-clean placement, pre-flagged Rotation Hours. */
export const PUT = handle(async (req: Request, ctx: { params: Promise<{ date: string }> }) => {
  const staff = await requireStaff("manager");
  const { date } = await ctx.params;
  if (!isValidDay(date)) throw new HttpError(400, "Bad date");
  const c = await body(req, D);
  const d = db();
  if (c.reset) {
    d.prepare("DELETE FROM day_config WHERE day = ?").run(date);
    audit(staff.email, "day_config_reset", date);
    emitChange(date);
    return json(getDayConfig(date));
  }
  if (c.closeMin <= c.openMin) throw new HttpError(400, "Close must be after open");
  // Never strand existing bookings: hours must still cover every live leg, and pre-flagged rotation hours must be free of 20-min legs.
  const legs = d.prepare("SELECT MIN(l.start_min) AS a, MAX(l.end_min) AS z FROM booking_legs l JOIN bookings b ON b.id = l.booking_id WHERE l.day = ? AND b.status IN ('hold','confirmed','arrived')").get(date) as { a: number | null; z: number | null };
  if (legs.a != null && (legs.a < c.openMin || (legs.z ?? 0) > c.closeMin)) throw new HttpError(409, "Existing bookings fall outside those hours");
  const ledger = buildLedger(date);
  const bad = c.rotationHours.filter((h) => ledger.gridLegs[h] > 0);
  if (bad.length) throw new HttpError(409, `Hours ${bad.join(", ")} already hold 20-min bookings`);
  d.prepare(
    `INSERT INTO day_config (day, open_min, close_min, peak, rotation_hours, holdback_pct, deep_clean_start, deep_clean_min, deep_clean_zone, all5_mode)
     VALUES (@day, @open, @close, @peak, @rot, @hb, @dcs, @dcm, @dcz, @a5)
     ON CONFLICT(day) DO UPDATE SET open_min=@open, close_min=@close, peak=@peak, rotation_hours=@rot, holdback_pct=@hb, deep_clean_start=@dcs, deep_clean_min=@dcm, deep_clean_zone=@dcz, all5_mode=@a5`,
  ).run({
    day: date, open: c.openMin, close: c.closeMin, peak: c.peak === "auto" ? null : c.peak === "peak" ? 1 : 0,
    rot: JSON.stringify(c.rotationHours), hb: c.holdbackPct, dcs: c.deepCleanStart, dcm: c.deepCleanStart == null ? 0 : c.deepCleanMin, dcz: c.deepCleanZone, a5: c.all5Mode ?? null,
  });
  audit(staff.email, "day_config_updated", date, c);
  emitChange(date);
  return json(getDayConfig(date));
});
