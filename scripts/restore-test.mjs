// Weekly restore test (§9): "an untested backup is a hope, not a backup".
// Restores the newest backup into a temporary database on the same server, checks foreign keys hold,
// verifies no room is over capacity on any day, and compares row counts with the live DB.
// Drops the temporary database afterwards. Exits non-zero on any problem.
// Env: DATABASE_URL, BACKUP_DIR. Needs pg_restore matching the server's major version.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { directUrl } from "./backup.mjs";

pg.types.setTypeParser(pg.types.builtins.INT8, Number);
const DIR = process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^won-\d+\.dump$/.test(f)).sort() : [];
if (!files.length) {
  console.error("[restore-test] no backups found in", DIR);
  process.exit(1);
}
const newest = path.join(DIR, files[files.length - 1]);
const live = directUrl();
const tmpName = `won_restore_${process.pid}`;
const tmpUrl = (() => {
  const u = new URL(live);
  u.pathname = `/${tmpName}`;
  return u.toString();
})();

const admin = new pg.Client({ connectionString: live });
await admin.connect();
const tables = ["bookings", "booking_legs", "payments", "invoices", "waivers", "customers"];
const problems = [];
let counts = {};
let liveCounts = {};
await admin.query(`CREATE DATABASE ${tmpName}`);
try {
  execFileSync("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", tmpUrl, newest], { stdio: "inherit" });
  const db = new pg.Client({ connectionString: tmpUrl });
  await db.connect();
  try {
    // Every FK is enforced on restore (--exit-on-error), so a dangling reference would have failed above.
    // Capacity invariant straight from SQL: per room per minute, booked headcount ≤ capacity.
    const over = (
      await db.query(
        `WITH live AS (SELECT l.day, l.room_id, l.start_min, l.end_min,
                              CASE WHEN p.shape = 'party' THEN r.capacity ELSE b.party_size END AS n
                       FROM booking_legs l JOIN bookings b ON b.id = l.booking_id JOIN products p ON p.id = b.product_id JOIN rooms r ON r.id = l.room_id
                       WHERE b.status IN ('confirmed','arrived','done'))
         SELECT live.day, live.room_id, m.x AS minute, SUM(n) AS occ, MAX(r.capacity) AS capacity
         FROM live JOIN generate_series(0, 1439) AS m(x) ON m.x >= live.start_min AND m.x < live.end_min JOIN rooms r ON r.id = live.room_id
         GROUP BY live.day, live.room_id, m.x HAVING SUM(n) > MAX(r.capacity) LIMIT 5`,
      )
    ).rows;
    if (over.length) problems.push(`capacity exceeded: ${JSON.stringify(over)}`);
    for (const t of tables) counts[t] = (await db.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n;
  } finally {
    await db.end();
  }
  for (const t of tables) liveCounts[t] = (await admin.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n;
  for (const t of tables) if (counts[t] > liveCounts[t]) problems.push(`${t}: backup has more rows than live (${counts[t]} > ${liveCounts[t]})`);
} catch (e) {
  problems.push(`restore failed: ${e.message}`);
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${tmpName} WITH (FORCE)`);
  await admin.end();
}
console.log(`[restore-test] ${path.basename(newest)}`, { backup: counts, live: liveCounts });
if (problems.length) {
  console.error("[restore-test] FAILED:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log("[restore-test] OK — backup restores cleanly and passes the capacity invariant");
