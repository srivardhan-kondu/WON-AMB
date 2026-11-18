import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { handle, json } from "@/lib/http";

/** WhatsApp outbox — in mock mode this is where confirmation, reminder and OTP messages land. */
export const GET = handle(async () => {
  await requireStaff("manager");
  const rows = db().prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 100").all() as { payload: string }[];
  return json({ messages: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })) });
});
