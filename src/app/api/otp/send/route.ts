import { z } from "zod";
import crypto from "node:crypto";
import { hashOtp, normalizePhone } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, body, handle, json, rateLimit, rateLimitKey } from "@/lib/http";
import { sendMessage } from "@/lib/messenger";

export const POST = handle(async (req: Request) => {
  rateLimit(req, "otp", 5);
  const { phone: raw } = await body(req, z.object({ phone: z.string() }));
  const phone = normalizePhone(raw);
  // Per-phone limits too (§9), so one number can't be spammed from many IPs: 1 per 30 s, 5 per hour.
  const last = db().prepare("SELECT expires FROM otps WHERE phone = ?").get(phone) as { expires: number } | undefined;
  if (last && last.expires - 5 * 60_000 + 30_000 > Date.now()) throw new HttpError(429, "A code was just sent — wait 30 seconds before asking again");
  rateLimitKey(`otp-phone:${phone}`, 5, 60 * 60_000);
  const code = String(crypto.randomInt(100000, 1000000));
  db().prepare("INSERT INTO otps (phone, code_hash, expires, attempts) VALUES (?, ?, ?, 0) ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, attempts = 0")
    .run(phone, hashOtp(phone, code), Date.now() + 5 * 60_000);
  await sendMessage(phone, "otp", { code });
  const dev = !process.env.WHATSAPP_TOKEN && process.env.NODE_ENV !== "production";
  return json({ sent: true, devCode: dev ? code : undefined });
});
