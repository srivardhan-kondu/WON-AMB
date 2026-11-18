import type { NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { sweep } from "@/lib/bookings";
import { events } from "@/lib/events";
import { handle } from "@/lib/http";
import { runsheet } from "@/lib/runsheet";
import { isValidDay, todayIST } from "@/lib/time";

/** SSE: pushes a fresh runsheet snapshot on every commit for the day, plus a 30 s heartbeat. */
export const GET = handle(async (req: NextRequest) => {
  await requireStaff("floor");
  const q = req.nextUrl.searchParams.get("date");
  const day = q && isValidDay(q) ? q : todayIST();
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        try {
          sweep();
          controller.enqueue(enc.encode(`data: ${JSON.stringify(runsheet(day))}\n\n`));
        } catch {
          cleanup();
        }
      };
      let pending: ReturnType<typeof setTimeout> | null = null;
      const onChange = (d: string) => {
        if (d !== day || pending) return;
        pending = setTimeout(() => {
          pending = null;
          send();
        }, 150);
      };
      events().on("change", onChange);
      const beat = setInterval(send, 30_000);
      cleanup = () => {
        events().off("change", onChange);
        clearInterval(beat);
        if (pending) clearTimeout(pending);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
      send();
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
});
