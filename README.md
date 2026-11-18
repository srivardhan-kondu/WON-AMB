# WON — World of Neon booking system

A full-stack Next.js build of the two design docs in the parent folder: one scheduling engine and four apps on top of it.

| App | URL | Who |
| --- | --- | --- |
| Booking site | `/` → `/pay/[code]` → `/b/[code]` (QR, guest list), plus `/w/[code]` (waivers), `/b/[code]/reschedule`, `/invoice/[code]`, `/waitlist/[token]`, `/me` (OTP: memberships + upcoming bookings) | Customers |
| Front desk | `/desk` (Today board, Walk-in, Check-in with QR camera, Party desk, Waitlist) | desk, manager, owner |
| Runsheet | `/runsheet` (live over SSE: now/next per room, changeover countdowns, cleanup timers, timeline, Rotation-Hour Latin squares) | floor and up |
| Owner dashboard | `/dashboard` (KPIs week vs last, day config + room blocks, prices + scheduled price changes, yield, refunds and GST export, memberships, audit feed, WhatsApp outbox, integrity) | manager, owner |
| Staff account | `/account` (authenticator-app 2FA, override PIN, password) | all staff |

## Run it

```bash
npm install
npm run dev            # http://localhost:3000
```

Set `DATABASE_URL` in `.env.local` to a Postgres database (production runs on Neon; use the pooled `-pooler` host). The schema is created and seeded on the first request. Demo staff logins all use the password `won12345`:
`owner@won.local`, `manager@won.local`, `desk@won.local`, `floor@won.local`.
Demo override PINs: manager `2468`, owner `1357`. Change all of these in `/account` before going live.

With no keys configured, payments and WhatsApp run in **test mode**:
- The pay page shows "simulate UPI success/failure" buttons. These drive the same code path as Razorpay's `payment.captured` and `payment.failed` webhooks.
- WhatsApp messages (confirmations, reminders, OTPs, waitlist offers) are written to **Dashboard → Messages** instead of being sent.

To go live, copy `.env.example` to `.env.local` and set `WON_SECRET`, the Razorpay keys (point the webhook at `/api/webhooks/razorpay`), and the WhatsApp Cloud API token. The WhatsApp templates must be pre-approved in Meta with the names listed in `src/lib/messenger.ts`.

## Checks

```bash
npm run simulate       # simulated Saturday + engine invariants (no server needed)
npm run typecheck
npm run lint
npm run backup && npm run restore-test   # pg_dump the DB, then prove the newest backup restores (needs pg_dump 18)
# end-to-end (122 checks) against a running server, on a THROWAWAY database (never production):
DATABASE_URL=$E2E_URL npm run build && DATABASE_URL=$E2E_URL npm start
npm run test:e2e -- http://localhost:3000 "$E2E_URL"
```

The e2e suite covers:
- Quote, hold, mock payment, confirm, invoice and QR
- Idempotency and webhook replay dedupe
- Waivers
- A 6-way race for the last seats: exactly one wins and the rest get alternatives
- Late payment, both re-committed and auto-refunded
- Rotation-Hour isolation and upsells
- Role gates
- Walk-in plus check-in with the waiver gate and party shrink
- Party exclusive blocks and the 48 h rule
- Day config, hold-back, price edits, KPIs and the runsheet
- OTP reschedule (once only, 24 h rule)
- Waitlist auto-offer on cancellation
- Manager-PIN overrides (cancel, comp, short-notice party) attributed to the right approver
- Flash prices (off-peak only, charged at hold)
- Member peak-hour horizon
- Staff TOTP login
- GST CSV export and the `/api/health` ledger check
- Guest-list edits, the customer `/me` view, per-phone OTP limits
- Manual room blocks, scheduled price changes, All 5 as 5 × 20 min
- Rejection logging (false sell-outs = 0), owner-only refunds
- Crash recovery: a corrupted row pauses bookings until a re-check passes

## How it maps to the design

- **Engine** (`src/lib/engine/`): a pure TypeScript port of algorithm doc §3–§6.
  - Minute-level `Ledger`
  - 20-min grid (15 play + 5 buffer)
  - Rotation Hours (5 × 12 min) that never mix with the grid
  - Splatter sessions on a 75-min cadence with a built-in 15-min cleanup
  - Combos with the inter-zone buffer
  - Exclusive party blocks with 30/15-min setup and teardown
  - `matchDistinct` (no false sell-outs)
  - The weighted scorer
  - Walk-in hold-back (released 2 h before the slot)
  - An optional per-day policy to sell All 5 as 5 × 20 min (100 min) on the normal grid (§3.3)
  - `falseSellouts()`: an independent Hall's-theorem check that runs on every refused search
- **Booking service** (`src/lib/bookings.ts`):
  - Quote → hold (10-min TTL) → commit. Every commit re-quotes at the exact start, inside an `IMMEDIATE` SQLite transaction, against a ledger rebuilt from the DB. That is the per-day lock.
  - `handlePaymentCaptured` is the single place money and seats can disagree: late payments re-commit if the seats are still free, or auto-refund and send alternatives if not.
  - Also here: auto no-show after start + 10 min, check-in waiver gate, one free reschedule ≥ 24 h ahead, waitlist auto-offer, sequential GST invoices, and memberships (a visit is burned at check-in).
- **Crash recovery** (`src/lib/integrity.ts`, §9): on every start, and on every `/api/health` probe, the next 14 days are rebuilt from the DB and checked. The checks: no room over capacity, no booking repeating a room, no hour mixing Rotation-Hour and 20-min legs, and every confirmed booking has rooms. Any failure pauses new bookings (holds, walk-ins, reschedules) until a manager re-checks under Dashboard → Integrity, or the owner reopens with their PIN. Check-in and payments for existing bookings keep working.
- **Scheduler** (`src/instrumentation.ts` → `src/lib/scheduler.ts`): runs every 60 s inside the server process.
  - Expires holds and marks no-shows
  - Runs waitlist offers
  - Sends the T−2 h visit reminder (with the unsigned-waiver nudge) and the T−1 day party summary
  - Sends `membership_update` 7 days before a membership expires (and on every visit used, with a renew nudge at ≤ 2 left)
  - Moves scheduled price changes into the catalogue on their effective date
- **Revenue rules** (`src/lib/yield.ts`):
  - Dead-slot flash prices (§8.5). At 8 pm the scheduler checks tomorrow's weekday-morning hours, and any under 25% game-zone utilization gets a Choice-of-3 price of ₹799. Managers can also open flash prices by hand. Peak hours are always refused.
  - Flash prices can carry a minimum group size, for a schools/colleges rate.
  - Member booking horizon (§7): peak visits up to 2 days ahead, off-peak up to 7.
  - Price changes can be scheduled with an effective-from date (§7). Quotes for a day use the price in force on that day.
  - Owner-approved refunds (§8): the owner's PIN is required. They go through Razorpay for online payments, or are recorded as counter refunds. The GST CSV gains a "Refunded" column for credit notes.
  - All thresholds are editable under Dashboard → Yield & GST.
- **Staff security**:
  - Optional TOTP 2FA (RFC 6238, no dependencies; `src/lib/totp.ts`).
  - Manager-PIN re-auth for every override (`src/lib/override.ts`): cancellation, comp ticket, reschedule override, short-notice party. A manager types their PIN on the desk device. PINs are unique, so the audit log names the approver.
- **Integrations** sit behind `PaymentProvider` (`src/lib/payments.ts`) and `sendMessage` (`src/lib/messenger.ts`). Swapping providers touches one file.

## Deliberate differences from the design doc

- **Next.js API routes instead of FastAPI**, so the engine is ported to TypeScript. The doc's simulation is reproduced in `npm run simulate`.
- **SQLite instead of Postgres**, for zero-setup local running. The schema matches doc §4, with times stored as (IST day, minute) and money in paise. Moving to Postgres means swapping `src/lib/db.ts` and replacing the `IMMEDIATE` transaction with `SELECT … FOR UPDATE` on the day row. Run a **single server process** either way: the lock and SSE feed are in-process, as the design specifies.

## Deploy (§10)

One Linux VPS (Ubuntu 24.04 or similar), no Docker. Needs Node 20+, [PM2](https://pm2.keymetrics.io) and [Caddy](https://caddyserver.com).

```bash
npm i -g pm2
git clone <repo> won && cd won
cp .env.example .env.local     # set WON_SECRET, WON_BASE_URL, Razorpay + WhatsApp keys
npm ci && npm run build
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup   # survive reboots
sudo cp Caddyfile /etc/caddy/Caddyfile                     # replace {$WON_DOMAIN} with your domain
sudo systemctl reload caddy
```

This runs:
- **won-app** (PM2): `next start` on 127.0.0.1:3000 with the engine and scheduler. SQLite lives at `./data/won.db`.
- **won-backup** (PM2): a daily online snapshot at 03:00 IST to `./backups`, kept 30 days. Set `BACKUP_OFFSITE_CMD` for an off-site copy.
- **Caddy** (systemd): automatic HTTPS, with SSE passed through unbuffered for the runsheet.

To update: `git pull && npm ci && npm run build && pm2 restart won-app`.

Run the weekly restore test with `npm run restore-test` (or add it to cron). Point UptimeRobot at `https://<domain>/api/health`: it returns 503 if any room is over capacity in the next 14 days.

Keep `won-app` at **one instance**. The commit lock and the runsheet feed are in-process, as the design specifies.

## Not built yet

- Moving the DB to Postgres. Only needed past single-server scale.
- Sentry error tracking. Add a DSN and `onRequestError` in `src/instrumentation.ts`.
- Booking a member visit online. Members book at the desk, where the visit is used at check-in. `/me` shows what's left.
- Not code: an OpenAPI spec, the 10× load test, staff training notes, a staging copy, and Cloudflare in front.

## Deploying on Vercel

- **Database:** Neon Postgres via `DATABASE_URL`. All commits run in a transaction holding one advisory lock (`src/lib/db.ts`), so two instances can never sell the same seat.
- **Region:** `vercel.json` pins functions to `sin1` (Singapore), next to the Neon database. Keep the two in the same region, because every request makes several queries.
- **Scheduler:** there's no long-lived process, so `runTick()` in `src/lib/scheduler.ts` (hold expiry, no-shows, reminders, waitlist, scheduled prices, flash check, integrity check) is triggered by:
  - API traffic, at most once a minute;
  - open runsheet screens;
  - Vercel Cron (`/api/cron/tick`, daily in `vercel.json`).

  For minute-level reminders when nobody is using the app, point an external pinger (cron-job.org, UptimeRobot) at `/api/cron/tick` every minute with the header `Authorization: Bearer $CRON_SECRET`. On Vercel Pro you can instead change the cron schedule to `* * * * *`.
- **Env vars:** `DATABASE_URL`, `WON_SECRET`, `CRON_SECRET`, `WON_BASE_URL`, plus the Razorpay and WhatsApp keys when going live.
