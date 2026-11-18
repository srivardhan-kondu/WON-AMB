// Weekly restore test (§9): "an untested backup is a hope, not a backup".
// Restores the newest backup to a temp file, runs integrity_check, verifies no room is over capacity
// on any day, and compares booking counts with the live DB. Exits non-zero on any problem.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const DIR = process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
const LIVE = process.env.WON_DB_PATH || path.join(process.cwd(), "data", "won.db");
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^won-\d+\.db\.gz$/.test(f)).sort() : [];
if (!files.length) {
  console.error("[restore-test] no backups found in", DIR);
  process.exit(1);
}
const newest = path.join(DIR, files[files.length - 1]);
const tmp = path.join(os.tmpdir(), `won-restore-${process.pid}.db`);
fs.writeFileSync(tmp, zlib.gunzipSync(fs.readFileSync(newest)));
const db = new Database(tmp, { readonly: true });
const problems = [];
const integrity = db.prepare("PRAGMA integrity_check").pluck().get();
if (integrity !== "ok") problems.push(`integrity_check: ${integrity}`);
const fk = db.prepare("PRAGMA foreign_key_check").all();
if (fk.length) problems.push(`${fk.length} foreign-key violations`);
// Capacity invariant straight from SQL: per room per minute, booked headcount ≤ capacity.
const over = db
  .prepare(
    `WITH RECURSIVE m(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM m WHERE x < 1439),
     live AS (SELECT l.day, l.room_id, l.start_min, l.end_min,
                     CASE WHEN p.shape = 'party' THEN r.capacity ELSE b.party_size END AS n
              FROM booking_legs l JOIN bookings b ON b.id = l.booking_id JOIN products p ON p.id = b.product_id JOIN rooms r ON r.id = l.room_id
              WHERE b.status IN ('confirmed','arrived','done'))
     SELECT live.day, live.room_id, m.x AS minute, SUM(n) AS occ, r.capacity
     FROM live JOIN m ON m.x >= live.start_min AND m.x < live.end_min JOIN rooms r ON r.id = live.room_id
     GROUP BY live.day, live.room_id, m.x HAVING SUM(n) > r.capacity LIMIT 5`,
  )
  .all();
if (over.length) problems.push(`capacity exceeded: ${JSON.stringify(over)}`);
const counts = Object.fromEntries(["bookings", "booking_legs", "payments", "invoices", "waivers", "customers"].map((t) => [t, db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get()]));
db.close();
fs.unlinkSync(tmp);
let liveCounts = null;
if (fs.existsSync(LIVE)) {
  const l = new Database(LIVE, { readonly: true });
  liveCounts = Object.fromEntries(Object.keys(counts).map((t) => [t, l.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get()]));
  l.close();
  for (const t of Object.keys(counts)) if (counts[t] > liveCounts[t]) problems.push(`${t}: backup has more rows than live (${counts[t]} > ${liveCounts[t]})`);
}
console.log(`[restore-test] ${path.basename(newest)}`, { backup: counts, live: liveCounts });
if (problems.length) {
  console.error("[restore-test] FAILED:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log("[restore-test] OK — backup restores cleanly and passes the capacity invariant");
