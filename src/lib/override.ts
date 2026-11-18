// Manager PIN re-auth for overrides (§7/§9): a desk user can perform an override when a manager or
// owner types their PIN at the counter; managers re-enter their own PIN too. Every use is audited.
import bcrypt from "bcryptjs";
import { db } from "./db";
import { HttpError, rateLimit } from "./http";
import type { StaffSession } from "./auth";
import { audit } from "./repo";

export function approveOverride(req: Request, staff: StaffSession, pin: string | null | undefined, action: string, roles: ("manager" | "owner")[] = ["manager", "owner"]): string {
  const who = roles.includes("manager") ? "Manager" : "Owner";
  if (!pin) throw new HttpError(403, `${who} PIN required for this override`, { needPin: true });
  rateLimit(req, "manager-pin", 10);
  const rows = db().prepare(`SELECT email, pin_hash FROM staff_users WHERE role IN (${roles.map(() => "?").join(",")}) AND active = 1 AND pin_hash IS NOT NULL`).all(...roles) as { email: string; pin_hash: string }[];
  // Prefer the acting user's own PIN if they are a manager.
  rows.sort((a, b) => (a.email === staff.email ? -1 : b.email === staff.email ? 1 : 0));
  const approver = rows.find((r) => bcrypt.compareSync(pin, r.pin_hash));
  if (!approver) {
    audit(staff.email, "override_pin_rejected", action);
    throw new HttpError(403, `Wrong ${who.toLowerCase()} PIN`, { needPin: true });
  }
  return approver.email;
}
