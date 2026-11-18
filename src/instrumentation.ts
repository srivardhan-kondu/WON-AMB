export async function register() {
  // On Vercel there is no long-lived process: ticks come from Vercel Cron and from requests (see scheduler.ts).
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build" && !process.env.VERCEL) {
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
  }
}
