// Auth: staff email+password → role-scoped JWT cookie; customers → phone OTP (reschedules only);
// bookings are otherwise retrievable by code + signed token (QR / WhatsApp link) or code + phone.

import { SignJWT, jwtVerify } from "jose";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { HttpError } from "./http";

export type Role = "desk" | "floor" | "manager" | "owner";
export interface StaffSession {
  sub: number;
  email: string;
  name: string;
  role: Role;
}

const DEV_SECRET = "won-dev-secret-change-me-please-0123456789";
let warned = false;
function secretString(): string {
  const s = process.env.WON_SECRET;
  if (!s && process.env.NODE_ENV === "production" && !warned) {
    warned = true;
    console.warn("[won] WON_SECRET is not set — using an insecure dev secret. Set it before going live.");
  }
  return s || DEV_SECRET;
}
const key = () => new TextEncoder().encode(secretString());

export const STAFF_COOKIE = "won_staff";
export const CUSTOMER_COOKIE = "won_cust";

export async function signStaff(s: StaffSession): Promise<string> {
  return new SignJWT({ email: s.email, name: s.name, role: s.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(s.sub))
    .setIssuedAt()
    .setExpirationTime("12h")
    .setAudience("staff")
    .sign(key());
}

export async function getStaff(): Promise<StaffSession | null> {
  const token = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { audience: "staff" });
    return { sub: Number(payload.sub), email: String(payload.email), name: String(payload.name), role: payload.role as Role };
  } catch {
    return null;
  }
}

/** Roles gate power, not screens (§9). Owner implies manager implies desk. Floor is runsheet-only. */
const RANK: Record<Role, number> = { floor: 0, desk: 1, manager: 2, owner: 3 };

export async function requireStaff(min: Role | Role[]): Promise<StaffSession> {
  const s = await getStaff();
  if (!s) throw new HttpError(401, "Staff login required");
  const ok = Array.isArray(min) ? min.includes(s.role) || (s.role === "owner") : RANK[s.role] >= RANK[min];
  if (!ok) throw new HttpError(403, `Your role (${s.role}) cannot do this`);
  return s;
}

export async function signCustomer(phone: string): Promise<string> {
  return new SignJWT({ phone }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2h").setAudience("customer").sign(key());
}

export async function getCustomerPhone(): Promise<string | null> {
  const token = (await cookies()).get(CUSTOMER_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { audience: "customer" });
    return String(payload.phone);
  } catch {
    return null;
  }
}

/** Signed token carried in QR codes and WhatsApp links — encodes the booking code only, no PII. */
export function bookingToken(code: string): string {
  return crypto.createHmac("sha256", secretString()).update(`booking:${code}`).digest("base64url").slice(0, 16);
}

export function verifyBookingToken(code: string, token: string | null | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(bookingToken(code));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function hashOtp(phone: string, code: string): string {
  return crypto.createHmac("sha256", secretString()).update(`otp:${phone}:${code}`).digest("hex");
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return "+" + digits;
  throw new HttpError(400, "Enter a valid 10-digit Indian mobile number");
}
