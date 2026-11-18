import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { handle, json } from "@/lib/http";

export const GET = handle(async () => {
  await requireStaff("manager");
  const rows = db().prepare("SELECT * FROM events_audit ORDER BY id DESC LIMIT 200").all() as { detail: string }[];
  return json({ events: rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) })) });
});
