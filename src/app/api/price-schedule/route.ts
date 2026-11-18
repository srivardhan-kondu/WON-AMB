import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, body, handle, json } from "@/lib/http";
import { applyDuePrices, audit, getProduct, type ScheduledPrice } from "@/lib/repo";
import { isValidDay, todayIST } from "@/lib/time";

/** §7 product & price editor with effective-from dates. Bookings for days on/after the date are quoted at the new price. */
export const GET = handle(async () => {
  await requireStaff("manager");
  const rows = await db().prepare("SELECT * FROM price_schedule WHERE effective_from > ? ORDER BY effective_from, product_id").all(todayIST()) as ScheduledPrice[];
  return json({ scheduled: rows });
});

const S = z.object({
  productId: z.string(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pricePaise: z.number().int().min(0).max(10_000_000),
  extraPaise: z.number().int().min(0).max(10_000_000).optional(),
});

export const POST = handle(async (req: Request) => {
  const staff = await requireStaff("owner");
  const s = await body(req, S);
  if (!isValidDay(s.effectiveFrom)) throw new HttpError(400, "Bad date");
  const p = await getProduct(s.productId);
  if (!p) throw new HttpError(404, "Unknown product");
  const today = todayIST();
  if (s.effectiveFrom < today) throw new HttpError(400, "Effective date can't be in the past");
  await db().prepare(
    `INSERT INTO price_schedule (product_id, effective_from, price_paise, extra_paise, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id, effective_from) DO UPDATE SET price_paise = excluded.price_paise, extra_paise = excluded.extra_paise, created_by = excluded.created_by, created_at = excluded.created_at`,
  ).run(p.id, s.effectiveFrom, s.pricePaise, s.extraPaise ?? p.extraPaise, staff.email, Date.now());
  await audit(staff.email, "price_scheduled", `product:${p.id}`, { from: s.effectiveFrom, price: s.pricePaise, extra: s.extraPaise ?? p.extraPaise, current: p.pricePaise });
  if (s.effectiveFrom === today) await applyDuePrices(today);
  return json({ ok: true }, 201);
});

export const DELETE = handle(async (req: NextRequest) => {
  const staff = await requireStaff("owner");
  const id = Number(req.nextUrl.searchParams.get("id"));
  const row = await db().prepare("SELECT * FROM price_schedule WHERE id = ? AND effective_from > ?").get(id, todayIST()) as ScheduledPrice | undefined;
  if (!row) throw new HttpError(404, "No future price change with that id");
  await db().prepare("DELETE FROM price_schedule WHERE id = ?").run(id);
  await audit(staff.email, "price_schedule_removed", `product:${row.product_id}`, { ...row });
  return json({ ok: true });
});
