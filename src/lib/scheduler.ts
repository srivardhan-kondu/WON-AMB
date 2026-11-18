// The clock: hold expiry, auto no-show, waitlist offers, time-based WhatsApp templates (§8), scheduled
// prices, the D-1 flash check and the periodic integrity check — all in one idempotent `runTick()`.
//
// Serverless has no long-lived process, so a tick is triggered three ways (whichever comes first):
//   • Vercel Cron → GET /api/cron/tick (vercel.json)
//   • any API request, at most once a minute (`maybeTick`, run after the response via `after()`)
//   • self-hosted `next start`: an in-process interval, as before (`startScheduler`)
// A tick is claimed in the DB first, so concurrent instances never double-send.

import { membershipParams, sweep } from "./bookings";
import { runIntegrityCheck } from "./integrity";
import { applyDuePrices } from "./repo";
import { bookingToken } from "./auth";
import { db } from "./db";
import { background } from "./background";
import { baseUrl, sendMessage } from "./messenger";
import { addDays, fmtDay, fmtMin, nowIST } from "./time";
import { autoFlashForTomorrow } from "./yield";

const VISIT_REMINDER = 1;
const PARTY_SUMMARY = 2;
const TICK_EVERY_MS = 60_000;
const INTEGRITY_EVERY_MS = 60 * 60_000;

export async function sendDueReminders() {
  const d = db();
  const { day, min } = nowIST();

  // T−2 h visit reminder, with the unsigned-waiver nudge (top check-in delay).
  const due = await d
    .prepare(
      `SELECT b.id, b.code, b.day, b.start_min, b.party_size, c.phone, c.name,
              (SELECT COUNT(*) FROM waivers w WHERE w.booking_id = b.id) AS waivers
       FROM bookings b JOIN customers c ON c.id = b.customer_id
       WHERE b.status = 'confirmed' AND (b.reminded & ${VISIT_REMINDER}) = 0 AND b.day = ? AND b.start_min - ? BETWEEN 0 AND 120`,
    )
    .all<{ id: number; code: string; day: string; start_min: number; party_size: number; phone: string; name: string; waivers: number }>(day, min);
  for (const b of due) {
    const claimed = await d.prepare(`UPDATE bookings SET reminded = reminded | ${VISIT_REMINDER} WHERE id = ? AND (reminded & ${VISIT_REMINDER}) = 0`).run(b.id);
    if (!claimed.changes) continue;
    const missing = b.party_size - b.waivers;
    await sendMessage(b.phone, "visit_reminder", {
      name: b.name || "there",
      when: fmtMin(b.start_min),
      waivers: missing > 0 ? `${missing} guest(s) still need to sign: ${baseUrl()}/w/${b.code}?t=${bookingToken(b.code)}` : "All waivers signed ✓",
    });
  }

  // T−1 day party summary: headcount confirm, food flag, arrival time.
  const parties = await d
    .prepare(
      `SELECT b.id, b.code, b.start_min, b.party_size, b.food, c.phone, c.name
       FROM bookings b JOIN customers c ON c.id = b.customer_id JOIN products p ON p.id = b.product_id
       WHERE p.shape = 'party' AND b.status = 'confirmed' AND (b.reminded & ${PARTY_SUMMARY}) = 0 AND b.day = ?`,
    )
    .all<{ id: number; code: string; start_min: number; party_size: number; food: number; phone: string; name: string }>(addDays(day, 1));
  for (const p of parties) {
    const claimed = await d.prepare(`UPDATE bookings SET reminded = reminded | ${PARTY_SUMMARY} WHERE id = ? AND (reminded & ${PARTY_SUMMARY}) = 0`).run(p.id);
    if (!claimed.changes) continue;
    await sendMessage(p.phone, "party_summary", {
      name: p.name || "there",
      when: `${fmtDay(addDays(day, 1))}, ${fmtMin(p.start_min)}`,
      arrive: fmtMin(p.start_min - 15),
      headcount: String(p.party_size),
      food: p.food ? "Food add-on booked" : "No food add-on",
      link: `${baseUrl()}/b/${p.code}?t=${bookingToken(p.code)}`,
    });
  }
}

/** §8 membership_update at expiry T−7 days (once per membership). */
export async function sendMembershipExpiryReminders() {
  const d = db();
  const { day } = nowIST();
  const due = await d
    .prepare(
      `SELECT m.id, m.visits_left, m.valid_till, c.phone, c.name FROM memberships m JOIN customers c ON c.id = m.customer_id
       WHERE m.expiry_reminded = 0 AND m.valid_till >= ? AND m.valid_till <= ? AND (m.visits_left IS NULL OR m.visits_left > 0)`,
    )
    .all<{ id: number; visits_left: number | null; valid_till: string; phone: string; name: string }>(day, addDays(day, 7));
  for (const m of due) {
    const claimed = await d.prepare("UPDATE memberships SET expiry_reminded = 1 WHERE id = ? AND expiry_reminded = 0").run(m.id);
    if (!claimed.changes) continue;
    await sendMessage(m.phone, "membership_update", membershipParams(m, `Your membership expires on ${fmtDay(m.valid_till)} — renew to keep your visits`));
  }
}

/** Atomically claim a periodic job: true for exactly one caller per `everyMs` window, across instances. */
async function claim(key: string, everyMs: number): Promise<boolean> {
  const t = Date.now();
  const r = await db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE settings.value::bigint <= ?`,
    )
    .run(key, String(t), t - everyMs);
  return r.changes > 0;
}

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(`[won] ${name} failed`, e);
  }
}

/** One scheduler tick. Safe to call from anywhere, any number of times: it only runs once per minute. */
export async function runTick(opts: { force?: boolean } = {}) {
  if (!(await claim("tick_last", opts.force ? 0 : TICK_EVERY_MS - 5_000))) return { ran: false };
  await step("sweep", () => sweep(true));
  await step("reminders", sendDueReminders);
  await step("membership reminders", sendMembershipExpiryReminders);
  // Scheduled price changes take over the catalogue on their date.
  await step("price schedule", () => applyDuePrices(nowIST().day));
  // D-1 dead-slot check, once the day's bookings have mostly landed (after 20:00 IST).
  if (nowIST().min >= 20 * 60) await step("flash check", autoFlashForTomorrow);
  // Crash recovery (§9): rebuild the ledger from the DB and compare against the invariants.
  if (await claim("integrity_last", INTEGRITY_EVERY_MS)) {
    await step("integrity check", async () => {
      const problems = await runIntegrityCheck("tick");
      if (!problems.length) console.log("[won] ledger rebuilt from DB — invariants hold for the next 14 days");
    });
  }
  return { ran: true };
}

let lastLocalTick = 0;
/** Cheap per-request hook: at most one tick attempt per instance per minute, after the response. */
export function maybeTick() {
  const t = Date.now();
  if (t - lastLocalTick < TICK_EVERY_MS) return;
  lastLocalTick = t;
  background(() => runTick());
}

declare global {
  var __wonScheduler: ReturnType<typeof setInterval> | undefined;
}

/** Self-hosted (`next start` on a server): an in-process clock, so ticks run even with no traffic. */
export function startScheduler() {
  if (globalThis.__wonScheduler) return;
  const tick = () => runTick().catch((e) => console.error("[won] tick failed", e));
  globalThis.__wonScheduler = setInterval(tick, TICK_EVERY_MS);
  setTimeout(tick, 2_000);
}
