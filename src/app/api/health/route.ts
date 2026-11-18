import { db } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { INTEGRITY_DAYS, integrityLock, runIntegrityCheck } from "@/lib/integrity";

/**
 * Uptime probe + crash-recovery check (§9): rebuild the ledger for the next 14 days from the DB and
 * verify the engine invariants. Any violation is a 503 (loud, for UptimeRobot to page on) and pauses
 * new bookings until a manager reviews it in Dashboard → Integrity.
 */
export const GET = handle(async () => {
  const t = Date.now();
  db().prepare("SELECT 1").get();
  const problems = runIntegrityCheck("health");
  const locked = !!integrityLock();
  const ok = problems.length === 0 && !locked;
  return json({ ok, problems, bookingsPaused: locked, checkedDays: INTEGRITY_DAYS, ms: Date.now() - t }, ok ? 200 : 503);
});
