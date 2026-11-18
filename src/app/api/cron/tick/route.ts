import { HttpError, handle, json } from "@/lib/http";
import { runTick } from "@/lib/scheduler";

/**
 * Scheduler tick for Vercel Cron (or any external pinger such as cron-job.org / UptimeRobot).
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when CRON_SECRET is set.
 */
export const GET = handle(async (req: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) throw new HttpError(401, "Unauthorized");
  return json(await runTick());
});
