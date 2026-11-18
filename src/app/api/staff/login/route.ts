import { z } from "zod";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { STAFF_COOKIE, signStaff, type Role } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, body, handle, json, rateLimit } from "@/lib/http";
import { audit } from "@/lib/repo";
import { verifyTotp } from "@/lib/totp";

export const POST = handle(async (req: Request) => {
  rateLimit(req, "staff-login", 10);
  const { email, password, totp } = await body(req, z.object({ email: z.string().email(), password: z.string().min(1), totp: z.string().optional() }));
  const u = await db().prepare("SELECT * FROM staff_users WHERE email = ? AND active = 1").get(email.toLowerCase()) as
    | { id: number; email: string; name: string; role: Role; password_hash: string; totp_secret: string | null; totp_enabled: number }
    | undefined;
  if (!u || !bcrypt.compareSync(password, u.password_hash)) throw new HttpError(401, "Wrong email or password");
  if (u.totp_enabled && u.totp_secret) {
    if (!totp) throw new HttpError(401, "Enter the 6-digit code from your authenticator app", { needTotp: true });
    if (!verifyTotp(u.totp_secret, totp.trim())) {
      await audit(u.email, "staff_login_totp_failed", `staff:${u.id}`);
      throw new HttpError(401, "Wrong authenticator code", { needTotp: true });
    }
  }
  (await cookies()).set(STAFF_COOKIE, await signStaff({ sub: u.id, email: u.email, name: u.name, role: u.role }), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 12 * 3600, path: "/",
  });
  await audit(u.email, "staff_login", `staff:${u.id}`);
  return json({ name: u.name, role: u.role });
});
