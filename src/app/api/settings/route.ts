import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { body, handle, json } from "@/lib/http";
import { audit, venueDefaults } from "@/lib/repo";

export const GET = handle(async () => {
  await requireStaff("manager");
  return json(venueDefaults());
});

const S = z.object({
  openMin: z.number().int().min(0).max(1440),
  closeMin: z.number().int().min(0).max(1440),
  holdbackPct: z.number().int().min(0).max(80),
  deepCleanStart: z.number().int().min(0).max(1440).nullable(),
  deepCleanMin: z.number().int().min(0).max(120),
  deepCleanZone: z.enum(["game", "splatter"]),
  all5Mode: z.enum(["rotation", "grid"]).optional(),
});

/** Venue-wide defaults; per-day overrides live in day_config. */
export const PUT = handle(async (req: Request) => {
  const staff = await requireStaff("owner");
  const s = await body(req, S);
  const up = db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  up.run("open_min", JSON.stringify(s.openMin));
  up.run("close_min", JSON.stringify(s.closeMin));
  up.run("holdback_pct", JSON.stringify(s.holdbackPct));
  up.run("deep_clean_start", JSON.stringify(s.deepCleanStart));
  up.run("deep_clean_min", JSON.stringify(s.deepCleanMin));
  up.run("deep_clean_zone", JSON.stringify(s.deepCleanZone));
  if (s.all5Mode) up.run("all5_mode", JSON.stringify(s.all5Mode));
  audit(staff.email, "venue_defaults_updated", "settings", s);
  return json(venueDefaults());
});
