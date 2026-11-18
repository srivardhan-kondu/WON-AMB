// Nightly backup (§9): online SQLite snapshot → gzip → retention, optional off-site copy.
//   node scripts/backup.mjs              one backup now
//   node scripts/backup.mjs --daemon     run forever, backing up daily at BACKUP_HOUR_IST (default 3)
// Env: WON_DB_PATH, BACKUP_DIR (default ./backups), BACKUP_RETENTION_DAYS (30),
//      BACKUP_OFFSITE_CMD — optional shell command run with the file path appended,
//      e.g. "rclone copy --s3-no-check-bucket" + " remote:won-backups" style wrappers, or "aws s3 cp {file} s3://bucket/".
import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DB = process.env.WON_DB_PATH || path.join(process.cwd(), "data", "won.db");
const DIR = process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
const KEEP_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 30);
const HOUR = Number(process.env.BACKUP_HOUR_IST || 3);

export async function backupOnce() {
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const raw = path.join(DIR, `won-${stamp}.db`);
  const src = new Database(DB, { readonly: true, fileMustExist: true });
  await src.backup(raw); // consistent online snapshot, safe while the app is writing
  src.close();
  const check = new Database(raw, { readonly: true });
  const ok = check.prepare("PRAGMA integrity_check").pluck().get();
  check.close();
  if (ok !== "ok") throw new Error(`integrity_check failed on fresh backup: ${ok}`);
  const gz = `${raw}.gz`;
  fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(raw), { level: 9 }));
  fs.unlinkSync(raw);
  if (process.env.BACKUP_OFFSITE_CMD) {
    const cmd = process.env.BACKUP_OFFSITE_CMD.includes("{file}") ? process.env.BACKUP_OFFSITE_CMD.replaceAll("{file}", gz) : `${process.env.BACKUP_OFFSITE_CMD} ${gz}`;
    execSync(cmd, { stdio: "inherit" });
  }
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const f of fs.readdirSync(DIR)) {
    if (/^won-\d+\.db\.gz$/.test(f) && fs.statSync(path.join(DIR, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(DIR, f));
  }
  console.log(`[backup] ${gz} (${(fs.statSync(gz).size / 1024).toFixed(1)} KB)`);
  return gz;
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
