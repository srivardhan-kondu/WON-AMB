// PM2 process file (§10, no Docker): one app process + the nightly backup daemon.
//   npm ci && npm run build && pm2 start ecosystem.config.cjs && pm2 save
// Both read .env.local from this folder (Next loads it for the app; the backup needs DATABASE_URL/BACKUP_*).
module.exports = {
  apps: [
    {
      name: "won-app",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000 -H 127.0.0.1",
      // Commits are serialized in Postgres, so more instances are safe; one is plenty for one venue.
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production", TZ: "Asia/Kolkata" },
      max_memory_restart: "700M",
    },
    {
      name: "won-backup",
      script: "scripts/backup.mjs",
      args: "--daemon",
      env: { TZ: "Asia/Kolkata" },
    },
  ],
};
