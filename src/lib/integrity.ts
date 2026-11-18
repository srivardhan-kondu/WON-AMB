// Crash recovery = rebuild and compare (§9 software doc, §10 algorithm doc).
// On boot (and on demand) the ledger for the next 14 days is rebuilt from booking_legs + calendar_blocks
// and checked against the engine's invariants. Any violation logs loudly and blocks new bookings until
// a human (manager/owner) has looked: the DB never lies, but nothing new is sold on top of a bad state.

import { db } from "./db";
import { HttpError } from "./http";
import { audit, buildLedger } from "./repo";
import { addDays, todayIST } from "./time";

export const INTEGRITY_DAYS = 14;
const KEY = "integrity_lock";

export interface IntegrityLock { at: number; problems: string[] }

/** Rebuild every day's ledger from the DB and check capacity, distinct rooms, and cadence separation. */
export async function checkIntegrity(days = INTEGRITY_DAYS): Promise<string[]> {
  const today = todayIST();
  // Days are independent, so they are checked in parallel; results keep day order.
  const perDay = await Promise.all(Array.from({ length: days }, (_, i) => checkDay(addDays(today, i))));
  return perDay.flat();
}

async function checkDay(day: string): Promise<string[]> {
  const d = db();
  const problems: string[] = [];
  const [ledger, dupes, orphan] = await Promise.all([
    buildLedger(day),
    d
      .prepare(
        `SELECT b.code, l.room_id, COUNT(*) AS n FROM booking_legs l JOIN bookings b ON b.id = l.booking_id
         JOIN rooms r ON r.id = l.room_id JOIN products p ON p.id = b.product_id
         WHERE l.day = ? AND r.zone = 'game' AND p.shape != 'party' AND b.status IN ('hold','confirmed','arrived','done')
         GROUP BY b.id, l.room_id HAVING COUNT(*) > 1`,
      )
      .all<{ code: string; room_id: string; n: number }>(day),
    d
      .prepare(`SELECT b.code FROM bookings b WHERE b.day = ? AND b.status IN ('confirmed','arrived') AND NOT EXISTS (SELECT 1 FROM booking_legs l WHERE l.booking_id = b.id)`)
      .all<{ code: string }>(day),
  ]);
  for (const e of ledger.overCapacity()) problems.push(`${day}: ${e}`);
  for (const h of ledger.mixedCadenceHours()) problems.push(`${day}: ${h}:00 mixes Rotation-Hour and 20-min legs`);
  for (const x of dupes) problems.push(`${day}: ${x.code} visits ${x.room_id} ${x.n} times`);
  for (const x of orphan) problems.push(`${day}: ${x.code} is confirmed but has no room legs`);
  return problems;
}

export async function integrityLock(): Promise<IntegrityLock | null> {
  const r = await db().prepare("SELECT value FROM settings WHERE key = ?").get<{ value: string }>(KEY);
  return r ? (JSON.parse(r.value) as IntegrityLock) : null;
}

async function setLock(lock: IntegrityLock | null) {
  if (lock) await db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(lock));
  else await db().prepare("DELETE FROM settings WHERE key = ?").run(KEY);
}

/** Run the check; lock writes on any violation. Returns the problems found. */
export async function runIntegrityCheck(trigger: "boot" | "manual" | "health" | "tick", actor = "system"): Promise<string[]> {
  const problems = await checkIntegrity();
  if (problems.length) {
    console.error(`[won] LEDGER INVARIANT VIOLATED (${trigger}) — new bookings are blocked until a manager reviews`, problems);
    if (!(await integrityLock())) await audit(actor, "integrity_lock", "ledger", { trigger, problems });
    await setLock({ at: Date.now(), problems });
  } else if (trigger === "manual" && (await integrityLock())) {
    await setLock(null);
    await audit(actor, "integrity_cleared", "ledger", { trigger });
  }
  return problems;
}

/** Owner/manager override after looking at the problems: re-open sales even though the check still fails. */
export async function forceUnlock(actor: string, reason: string) {
  const lock = await integrityLock();
  await setLock(null);
  await audit(actor, "integrity_force_unlock", "ledger", { reason, problems: lock?.problems ?? [] });
}

/** Gate for every path that sells new capacity. */
export async function assertWritable() {
  const lock = await integrityLock();
  if (lock) throw new HttpError(503, "Bookings are paused while staff check the schedule — please try again shortly or call the desk", { integrityLock: true });
}
