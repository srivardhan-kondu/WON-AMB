import type { NextRequest } from "next/server";
import { z } from "zod";
import { normalizePhone, requireStaff } from "@/lib/auth";
import { activeMembership } from "@/lib/bookings";
import { db } from "@/lib/db";
import { body, handle, json } from "@/lib/http";
import { audit, upsertCustomer } from "@/lib/repo";
import { addDays, todayIST } from "@/lib/time";

export const GET = handle(async (req: NextRequest) => {
  await requireStaff("desk");
  const phone = req.nextUrl.searchParams.get("phone");
  if (phone) return json({ membership: activeMembership(normalizePhone(phone), todayIST()) ?? null });
  const rows = db()
    .prepare("SELECT m.*, c.name, c.phone, (SELECT COUNT(*) FROM membership_visits v WHERE v.membership_id = m.id) AS used FROM memberships m JOIN customers c ON c.id = m.customer_id ORDER BY m.valid_till DESC")
    .all();
  return json({ memberships: rows });
});

const M = z.object({
  name: z.string().trim().min(1),
  phone: z.string(),
  plan: z.string().trim().min(2).max(60),
  months: z.union([z.literal(6), z.literal(12)]),
  visits: z.number().int().min(1).max(500).nullable(),
});

export const POST = handle(async (req: Request) => {
  const staff = await requireStaff("manager");
  const m = await body(req, M);
  const customerId = upsertCustomer(normalizePhone(m.phone), m.name);
  const validTill = addDays(todayIST(), m.months === 6 ? 182 : 365);
  const id = db().prepare("INSERT INTO memberships (customer_id, plan, valid_till, visits_left, created_at) VALUES (?, ?, ?, ?, ?)").run(customerId, m.plan, validTill, m.visits, Date.now()).lastInsertRowid;
  audit(staff.email, "membership_created", `membership:${id}`, m);
  return json({ id: Number(id), validTill }, 201);
});
