// In-process clock (the one app process holds the engine). Runs the sweep — hold expiry, auto no-show,
// waitlist offers — even with no traffic, and sends the time-based WhatsApp templates (§8).

import { membershipParams, sweep } from "./bookings";
import { runIntegrityCheck } from "./integrity";
import { applyDuePrices } from "./repo";
import { bookingToken } from "./auth";
import { db } from "./db";
import { baseUrl, sendMessage } from "./messenger";
import { addDays, fmtDay, fmtMin, nowIST } from "./time";
import { autoFlashForTomorrow } from "./yield";

const VISIT_REMINDER = 1;
const PARTY_SUMMARY = 2;

export async function sendDueReminders() {
  const d = db();
  const { day, min } = nowIST();

  // T−2 h visit reminder, with the unsigned-waiver nudge (top check-in delay).
  const due = d
    .prepare(
      `SELECT b.id, b.code, b.day, b.start_min, b.party_size, c.phone, c.name,
              (SELECT COUNT(*) FROM waivers w WHERE w.booking_id = b.id) AS waivers
       FROM bookings b JOIN customers c ON c.id = b.customer_id
       WHERE b.status = 'confirmed' AND (b.reminded & ${VISIT_REMINDER}) = 0 AND b.day = ? AND b.start_min - ? BETWEEN 0 AND 120`,
    )
    .all(day, min) as { id: number; code: string; day: string; start_min: number; party_size: number; phone: string; name: string; waivers: number }[];
  for (const b of due) {
    d.prepare(`UPDATE bookings SET reminded = reminded | ${VISIT_REMINDER} WHERE id = ?`).run(b.id);
    const missing = b.party_size - b.waivers;
    await sendMessage(b.phone, "visit_reminder", {
      name: b.name || "there",
      when: fmtMin(b.start_min),
      waivers: missing > 0 ? `${missing} guest(s) still need to sign: ${baseUrl()}/w/${b.code}?t=${bookingToken(b.code)}` : "All waivers signed ✓",
    });
  }

  // T−1 day party summary: headcount confirm, food flag, arrival time.
  const parties = d
    .prepare(
      `SELECT b.id, b.code, b.start_min, b.party_size, b.food, c.phone, c.name
       FROM bookings b JOIN customers c ON c.id = b.customer_id JOIN products p ON p.id = b.product_id
       WHERE p.shape = 'party' AND b.status = 'confirmed' AND (b.reminded & ${PARTY_SUMMARY}) = 0 AND b.day = ?`,
    )
    .all(addDays(day, 1)) as { id: number; code: string; start_min: number; party_size: number; food: number; phone: string; name: string }[];
  for (const p of parties) {
    d.prepare(`UPDATE bookings SET reminded = reminded | ${PARTY_SUMMARY} WHERE id = ?`).run(p.id);
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
  const due = d
    .prepare(
      `SELECT m.id, m.visits_left, m.valid_till, c.phone, c.name FROM memberships m JOIN customers c ON c.id = m.customer_id
       WHERE m.expiry_reminded = 0 AND m.valid_till >= ? AND m.valid_till <= ? AND (m.visits_left IS NULL OR m.visits_left > 0)`,
    )
    .all(day, addDays(day, 7)) as { id: number; visits_left: number | null; valid_till: string; phone: string; name: string }[];
  for (const m of due) {
    d.prepare("UPDATE memberships SET expiry_reminded = 1 WHERE id = ?").run(m.id);
    await sendMessage(m.phone, "membership_update", membershipParams(m, `Your membership expires on ${fmtDay(m.valid_till)} — renew to keep your visits`));
  }
}

declare global {
  var __wonScheduler: ReturnType<typeof setInterval> | undefined;
}

export function startScheduler() {
  if (globalThis.__wonScheduler) return;
  // Crash recovery (§9): rebuild the ledger from the DB and compare against the invariants before selling anything.
  try {
    const problems = runIntegrityCheck("boot");
    if (!problems.length) console.log("[won] ledger rebuilt from DB — invariants hold for the next 14 days");
  } catch (e) {
    console.error("[won] integrity check failed to run", e);
  }
  const tick = () => {
    try {
      sweep(true);
    } catch (e) {
      console.error("[won] sweep failed", e);
    }
    sendDueReminders().catch((e) => console.error("[won] reminders failed", e));
    sendMembershipExpiryReminders().catch((e) => console.error("[won] membership reminders failed", e));
    try {
      applyDuePrices(nowIST().day); // scheduled price changes take over the catalogue on their date
    } catch (e) {
      console.error("[won] price schedule failed", e);
    }
    // D-1 dead-slot check, once the day's bookings have mostly landed (after 20:00 IST).
    try {
      if (nowIST().min >= 20 * 60) autoFlashForTomorrow();
    } catch (e) {
      console.error("[won] flash check failed", e);
    }
  };
  globalThis.__wonScheduler = setInterval(tick, 60_000);
  setTimeout(tick, 2_000);
}
