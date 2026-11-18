import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, body, handle, json } from "@/lib/http";
import { audit, getDayConfig, getProduct } from "@/lib/repo";
import { addDays, isValidDay, todayIST } from "@/lib/time";

export const GET = handle(async (req: NextRequest) => {
  await requireStaff("manager");
  const from = req.nextUrl.searchParams.get("from") || todayIST();
  if (!isValidDay(from)) throw new HttpError(400, "Bad date");
  const rows = await db().prepare("SELECT * FROM flash_offers WHERE day >= ? AND day < ? ORDER BY day, start_hour").all(from, addDays(from, 15));
  return json({ offers: rows });
});

const F = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  product: z.string(),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  pricePaise: z.number().int().min(100),
  /** Schools / colleges group rate (§8.5): the flash price only applies to parties at least this big. */
  minParty: z.number().int().min(1).max(40).default(1),
});

/** Manual flash price for off-peak hours. Peak hours are refused — the discount never leaks into peak. */
export const POST = handle(async (req: Request) => {
  const staff = await requireStaff("manager");
  const f = await body(req, F);
  const p = await getProduct(f.product, f.date);
  if (!p || p.pricing !== "pp" || p.shape === "party") throw new HttpError(400, "Flash prices apply to per-person game/splatter products");
  if (f.endHour <= f.startHour) throw new HttpError(400, "End must be after start");
  if (f.pricePaise >= p.pricePaise) throw new HttpError(400, "Flash price must be below the catalogue price");
  const peak = (await getDayConfig(f.date)).peakHours.filter((h) => h >= f.startHour && h < f.endHour);
  if (peak.length) throw new HttpError(409, `Hours ${peak.join(", ")} are peak — flash prices are off-peak only`);
  const info = await db()
    .prepare("INSERT INTO flash_offers (day, product_id, start_hour, end_hour, price_paise, min_party, auto, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id")
    .run<{ id: number }>(f.date, f.product, f.startHour, f.endHour, f.pricePaise, f.minParty, staff.email, Date.now());
  await audit(staff.email, "flash_offer_opened", `${f.date}@${f.startHour}:00`, f);
  return json({ id: info.rows[0].id }, 201);
});
