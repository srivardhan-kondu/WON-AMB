import { cookies } from "next/headers";
import { STAFF_COOKIE } from "@/lib/auth";
import { handle, json } from "@/lib/http";

export const POST = handle(async () => {
  (await cookies()).delete(STAFF_COOKIE);
  return json({ ok: true });
});
