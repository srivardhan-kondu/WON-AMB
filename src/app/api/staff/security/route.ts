import { z } from "zod";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, body, handle, json, rateLimit } from "@/lib/http";
import { audit } from "@/lib/repo";
import { newTotpSecret, otpauthUrl, verifyTotp } from "@/lib/totp";

interface Row { id: number; email: string; role: string; password_hash: string; totp_secret: string | null; totp_enabled: number; pin_hash: string | null }
const me = async (id: number) => (await db().prepare("SELECT * FROM staff_users WHERE id = ?").get<Row>(id))!;

export const GET = handle(async () => {
  const s = await requireStaff("floor");
  const u = await me(s.sub);
  return json({ totpEnabled: !!u.totp_enabled, hasPin: !!u.pin_hash, canHavePin: u.role === "manager" || u.role === "owner" });
});

const A = z.discriminatedUnion("action", [
  z.object({ action: z.literal("totp-setup") }),
  z.object({ action: z.literal("totp-enable"), code: z.string() }),
  z.object({ action: z.literal("totp-disable"), code: z.string() }),
  z.object({ action: z.literal("set-pin"), password: z.string(), pin: z.string().regex(/^\d{4,8}$/, "PIN must be 4–8 digits") }),
  z.object({ action: z.literal("set-password"), password: z.string(), newPassword: z.string().min(10, "Use at least 10 characters") }),
]);

/** Staff self-service: authenticator-app 2FA, manager override PIN, password change. */
export const POST = handle(async (req: Request) => {
  rateLimit(req, "staff-security", 20);
  const s = await requireStaff("floor");
  const a = await body(req, A);
  const u = await me(s.sub);
  const d = db();
  switch (a.action) {
    case "totp-setup": {
      if (u.totp_enabled) throw new HttpError(409, "2FA already on — disable it first");
      const secret = newTotpSecret();
      await d.prepare("UPDATE staff_users SET totp_secret = ? WHERE id = ?").run(secret, u.id);
      const url = otpauthUrl(secret, u.email);
      return json({ secret, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
    }
    case "totp-enable": {
      if (!u.totp_secret || !verifyTotp(u.totp_secret, a.code)) throw new HttpError(400, "Code didn't match — check the time on your phone");
      await d.prepare("UPDATE staff_users SET totp_enabled = 1 WHERE id = ?").run(u.id);
      await audit(u.email, "totp_enabled", `staff:${u.id}`);
      return json({ ok: true });
    }
    case "totp-disable": {
      if (!u.totp_secret || !verifyTotp(u.totp_secret, a.code)) throw new HttpError(400, "Code didn't match");
      await d.prepare("UPDATE staff_users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?").run(u.id);
      await audit(u.email, "totp_disabled", `staff:${u.id}`);
      return json({ ok: true });
    }
    case "set-pin": {
      if (u.role !== "manager" && u.role !== "owner") throw new HttpError(403, "Only managers and owners have an override PIN");
      if (!bcrypt.compareSync(a.password, u.password_hash)) throw new HttpError(403, "Wrong password");
      // PINs must be unique so every override is attributable to exactly one approver.
      const others = await d.prepare("SELECT pin_hash FROM staff_users WHERE id != ? AND pin_hash IS NOT NULL").all(u.id) as { pin_hash: string }[];
      if (others.some((o) => bcrypt.compareSync(a.pin, o.pin_hash))) throw new HttpError(409, "Choose a different PIN");
      await d.prepare("UPDATE staff_users SET pin_hash = ? WHERE id = ?").run(bcrypt.hashSync(a.pin, 10), u.id);
      await audit(u.email, "override_pin_changed", `staff:${u.id}`);
      return json({ ok: true });
    }
    case "set-password": {
      if (!bcrypt.compareSync(a.password, u.password_hash)) throw new HttpError(403, "Wrong password");
      await d.prepare("UPDATE staff_users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(a.newPassword, 10), u.id);
      await audit(u.email, "password_changed", `staff:${u.id}`);
      return json({ ok: true });
    }
  }
});
