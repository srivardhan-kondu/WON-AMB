import { z } from "zod";
import { cookies } from "next/headers";
import { CUSTOMER_COOKIE, hashOtp, normalizePhone, signCustomer } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, body, handle, json, rateLimit } from "@/lib/http";

export const POST = handle(async (req: Request) => {
  rateLimit(req, "otp-verify", 10);
  const v = await body(req, z.object({ phone: z.string(), code: z.string().regex(/^\d{6}$/) }));
  const phone = normalizePhone(v.phone);
  const d = db();
  const row = d.prepare("SELECT * FROM otps WHERE phone = ?").get(phone) as { code_hash: string; expires: number; attempts: number } | undefined;
  if (!row || row.expires < Date.now()) throw new HttpError(400, "Code expired — request a new one");
  if (row.attempts >= 5) throw new HttpError(429, "Too many attempts — request a new code");
  if (row.code_hash !== hashOtp(phone, v.code)) {
    d.prepare("UPDATE otps SET attempts = attempts + 1 WHERE phone = ?").run(phone);
    throw new HttpError(400, "Wrong code");
  }
  d.prepare("DELETE FROM otps WHERE phone = ?").run(phone);
  (await cookies()).set(CUSTOMER_COOKIE, await signCustomer(phone), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7200, path: "/" });
  return json({ ok: true });
});
