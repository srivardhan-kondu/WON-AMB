// SQLite persistence (better-sqlite3). Schema mirrors §4 of the software design doc;
// times are stored as (day, minutes-from-IST-midnight) and money in paise.
// The DB is the source of truth — the engine ledger is always rebuilt from it.

import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PRODUCTS, DEFAULT_ROOMS } from "./engine";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, zone TEXT NOT NULL CHECK (zone IN ('game','splatter')),
  capacity INTEGER NOT NULL, reset_min INTEGER NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', shape TEXT NOT NULL,
  legs INTEGER NOT NULL, leg_min INTEGER NOT NULL, play_min INTEGER NOT NULL,
  price_paise INTEGER NOT NULL, extra_paise INTEGER NOT NULL DEFAULT 0, pricing TEXT NOT NULL DEFAULT 'pp',
  zone TEXT NOT NULL, min_party INTEGER NOT NULL DEFAULT 1, max_party INTEGER NOT NULL DEFAULT 6,
  duration_min INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  customer_id INTEGER REFERENCES customers(id),
  day TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
  party_size INTEGER NOT NULL CHECK (party_size > 0),
  guest_list TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('hold','confirmed','arrived','no_show','done','cancelled','expired')),
  source TEXT NOT NULL,
  price_paise INTEGER NOT NULL,
  deposit_paise INTEGER NOT NULL DEFAULT 0,
  paid_paise INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  idem_key TEXT UNIQUE,
  hold_expires INTEGER,
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  food INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  membership_id INTEGER,
  arrived_at INTEGER,
  reminded INTEGER NOT NULL DEFAULT 0,       -- bit 1: visit_reminder sent, bit 2: party_summary sent
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_day ON bookings(day, status);
CREATE TABLE IF NOT EXISTS booking_legs (
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  leg_no INTEGER NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(id),
  day TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
  PRIMARY KEY (booking_id, leg_no)
);
CREATE INDEX IF NOT EXISTS legs_room ON booking_legs(day, room_id, start_min);
CREATE TABLE IF NOT EXISTS calendar_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES rooms(id),
  day TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
  reason TEXT NOT NULL, booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS blocks_day ON calendar_blocks(day);
CREATE TABLE IF NOT EXISTS day_config (
  day TEXT PRIMARY KEY, open_min INTEGER, close_min INTEGER, peak INTEGER, peak_hours TEXT,
  rotation_hours TEXT NOT NULL DEFAULT '[]', holdback_pct INTEGER,
  deep_clean_start INTEGER, deep_clean_min INTEGER, deep_clean_zone TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER REFERENCES bookings(id),
  provider TEXT NOT NULL, provider_order_id TEXT UNIQUE, provider_payment_id TEXT UNIQUE,
  amount_paise INTEGER NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'booking',
  raw TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS waivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  customer_id INTEGER, guest_name TEXT NOT NULL, age_band TEXT NOT NULL, signed_at INTEGER NOT NULL,
  ip TEXT, signed_via TEXT NOT NULL DEFAULT 'online'
);
CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id),
  plan TEXT NOT NULL, valid_till TEXT NOT NULL, visits_left INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS membership_visits (
  membership_id INTEGER NOT NULL REFERENCES memberships(id), booking_id INTEGER NOT NULL REFERENCES bookings(id),
  used_at INTEGER NOT NULL, PRIMARY KEY (membership_id, booking_id)
);
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, hour INTEGER NOT NULL, product_id TEXT NOT NULL,
  customer_id INTEGER NOT NULL, party_size INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','offered','accepted','expired','cancelled')),
  offer_start INTEGER, offer_expires INTEGER, token TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('desk','floor','manager','owner')), password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS events_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}', at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER UNIQUE NOT NULL REFERENCES bookings(id),
  number TEXT UNIQUE NOT NULL, fy TEXT NOT NULL, seq INTEGER NOT NULL, gst_detail TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_phone TEXT NOT NULL, template TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, provider_id TEXT, error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flash_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES products(id),
  start_hour INTEGER NOT NULL, end_hour INTEGER NOT NULL, price_paise INTEGER NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (day, product_id, start_hour)
);
CREATE TABLE IF NOT EXISTS price_schedule (                 -- price changes with an effective-from date (§7)
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL REFERENCES products(id),
  effective_from TEXT NOT NULL, price_paise INTEGER NOT NULL, extra_paise INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (product_id, effective_from)
);
CREATE TABLE IF NOT EXISTS quote_rejections (               -- feeds the false sell-out KPI (§12)
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, product_id TEXT NOT NULL, party INTEGER NOT NULL,
  channel TEXT NOT NULL, false_sellout INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rejections_at ON quote_rejections(at);
`;

function seed(db: Database.Database) {
  const roomCount = (db.prepare("SELECT COUNT(*) AS n FROM rooms").get() as { n: number }).n;
  if (roomCount === 0) {
    const ins = db.prepare("INSERT INTO rooms (id, name, zone, capacity, reset_min, sort) VALUES (?, ?, ?, ?, ?, ?)");
    DEFAULT_ROOMS.forEach((r, i) => ins.run(r.id, r.name, r.zone, r.capacity, r.resetMin, i));
  }
  const productCount = (db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n;
  if (productCount === 0) {
    const ins = db.prepare(
      `INSERT INTO products (id, name, description, shape, legs, leg_min, play_min, price_paise, extra_paise, pricing, zone, min_party, max_party, duration_min, active, sort)
       VALUES (@id, @name, @description, @shape, @legs, @legMin, @playMin, @pricePaise, @extraPaise, @pricing, @zone, @minParty, @maxParty, @durationMin, @active, @sort)`,
    );
    DEFAULT_PRODUCTS.forEach((p, i) => ins.run({ ...p, active: p.active ? 1 : 0, sort: i }));
  }
  const staffCount = (db.prepare("SELECT COUNT(*) AS n FROM staff_users").get() as { n: number }).n;
  if (staffCount === 0) {
    // Demo accounts — change these passwords before going live.
    const ins = db.prepare("INSERT INTO staff_users (email, name, role, password_hash) VALUES (?, ?, ?, ?)");
    const pw = process.env.WON_SEED_PASSWORD || "won12345";
    const hash = bcrypt.hashSync(pw, 10);
    ins.run("owner@won.local", "Owner", "owner", hash);
    ins.run("manager@won.local", "Manager", "manager", hash);
    ins.run("desk@won.local", "Front Desk", "desk", hash);
    ins.run("floor@won.local", "Floor Staff", "floor", hash);
  }
}

declare global {
  var __wonDb: Database.Database | undefined;
}

export function db(): Database.Database {
  if (globalThis.__wonDb) return globalThis.__wonDb;
  // Serverless hosts (Vercel) have a read-only filesystem except /tmp.
  const file =
    process.env.WON_DB_PATH ||
    (process.env.VERCEL ? path.join("/tmp", "won.db") : path.join(process.cwd(), "data", "won.db"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.pragma("busy_timeout = 5000");
  d.exec(SCHEMA);
  seed(d);
  const addCol = (table: string, col: string, ddl: string) => {
    const cols = (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  };
  addCol("bookings", "reminded", "INTEGER NOT NULL DEFAULT 0");
  addCol("bookings", "refunded_paise", "INTEGER NOT NULL DEFAULT 0");
  addCol("memberships", "expiry_reminded", "INTEGER NOT NULL DEFAULT 0");
  addCol("day_config", "all5_mode", "TEXT");
  addCol("flash_offers", "min_party", "INTEGER NOT NULL DEFAULT 1");
  addCol("calendar_blocks", "created_by", "TEXT");
  const staffCols = (d.prepare("PRAGMA table_info(staff_users)").all() as { name: string }[]).map((c) => c.name);
  if (!staffCols.includes("totp_secret")) d.exec("ALTER TABLE staff_users ADD COLUMN totp_secret TEXT");
  if (!staffCols.includes("totp_enabled")) d.exec("ALTER TABLE staff_users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0");
  if (!staffCols.includes("pin_hash")) {
    d.exec("ALTER TABLE staff_users ADD COLUMN pin_hash TEXT");
    // Demo override PINs (must differ, so the audit trail knows who approved). Change them in /account.
    d.prepare("UPDATE staff_users SET pin_hash = ? WHERE role = 'manager'").run(bcrypt.hashSync(process.env.WON_SEED_MANAGER_PIN || "2468", 10));
    d.prepare("UPDATE staff_users SET pin_hash = ? WHERE role = 'owner'").run(bcrypt.hashSync(process.env.WON_SEED_OWNER_PIN || "1357", 10));
  }
  globalThis.__wonDb = d;
  return d;
}

export const now = () => Date.now();
