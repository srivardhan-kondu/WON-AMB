// Nightly backup (§9): pg_dump (custom format, compressed) → verify → retention, optional off-site copy.
// Neon already keeps point-in-time history; this is a second copy that lives outside Neon.
//   node scripts/backup.mjs              one backup now
//   node scripts/backup.mjs --daemon     run forever, backing up daily at BACKUP_HOUR_IST (default 3)
// Env: DATABASE_URL (or BACKUP_DATABASE_URL), BACKUP_DIR (default ./backups), BACKUP_RETENTION_DAYS (30),
//      BACKUP_OFFSITE_CMD — optional shell command; {file} is replaced by the backup path, else it is appended.
// Needs pg_dump/pg_restore of the same major version as the server (Neon: 18) on PATH.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
const KEEP_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 30);
const HOUR = Number(process.env.BACKUP_HOUR_IST || 3);

/** pg_dump wants a direct connection; Neon's pooled host is the same host without "-pooler". */
export function directUrl() {
  const url = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url.replace("-pooler.", ".");
}

export async function backupOnce() {
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const file = path.join(DIR, `won-${stamp}.dump`);
  // Consistent snapshot (pg_dump runs in one repeatable-read transaction); safe while the app is writing.
  execFileSync("pg_dump", ["--format=custom", "--compress=9", "--no-owner", "--no-privileges", "--file", file, directUrl()], { stdio: "inherit" });
  // Verify the archive is readable and holds the core tables.
  const toc = execFileSync("pg_restore", ["--list", file], { encoding: "utf8" });
  for (const t of ["bookings", "booking_legs", "payments", "invoices"]) {
    if (!new RegExp(`TABLE DATA public ${t} `).test(toc)) throw new Error(`backup is missing table data for ${t}`);
  }
  if (process.env.BACKUP_OFFSITE_CMD) {
    const cmd = process.env.BACKUP_OFFSITE_CMD.includes("{file}") ? process.env.BACKUP_OFFSITE_CMD.replaceAll("{file}", file) : `${process.env.BACKUP_OFFSITE_CMD} ${file}`;
    execSync(cmd, { stdio: "inherit" });
  }
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const f of fs.readdirSync(DIR)) {
    if (/^won-\d+\.dump$/.test(f) && fs.statSync(path.join(DIR, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(DIR, f));
  }
  console.log(`[backup] ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
  return file;
}

if (process.argv.includes("--daemon")) {
  let lastDay = "";
  const tick = async () => {
    const ist = new Date(Date.now() + 330 * 60_000);
    const day = ist.toISOString().slice(0, 10);
    if (ist.getUTCHours() === HOUR && day !== lastDay) {
      lastDay = day;
      try {
        await backupOnce();
      } catch (e) {
        console.error("[backup] FAILED", e);
      }
    }
  };
  console.log(`[backup] daemon: daily at ${HOUR}:00 IST → ${DIR}, keep ${KEEP_DAYS} days`);
  setInterval(tick, 60_000);
  tick();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  await backupOnce();
}
