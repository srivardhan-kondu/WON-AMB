// Work that must not delay (or fail) the response: WhatsApp sends, waitlist offers, scheduler ticks.
// On Vercel the function is frozen once the response is sent, so it is handed to Next's `after()`,
// which keeps the instance alive until it finishes. Outside a request (self-hosted interval) it just runs.

import { after } from "next/server";
import { outsideTx } from "./db";

export function background(task: () => Promise<unknown>) {
  const run = () =>
    outsideTx(task).catch((e) => {
      console.error("[won] background task failed", e);
    });
  try {
    after(run);
  } catch {
    setTimeout(run, 0);
  }
}
