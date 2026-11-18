import type { NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { sweep } from "@/lib/bookings";
import { events } from "@/lib/events";
import { handle } from "@/lib/http";
import { runsheet } from "@/lib/runsheet";
import { maybeTick } from "@/lib/scheduler";
import { isValidDay, todayIST } from "@/lib/time";

const POLL_MS = 4_000;
const HEARTBEAT_MS = 25_000;
// Serverless functions have a maximum duration; end the stream before it and let EventSource reconnect.
const STREAM_MS = 55_000;

/**
 * SSE: pushes a fresh runsheet snapshot whenever it changes. Commits on this instance are pushed
 * immediately (in-process events); commits on other instances are picked up by a short DB poll.
 */
export const GET = handle(async (req: NextRequest) => {
  await requireStaff("floor");
  const q = req.nextUrl.searchParams.get("date");
  const day = q && isValidDay(q) ? q : todayIST();
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let last = "";
      let busy = false;
      const write = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      const send = async (force = false) => {
        if (busy || closed) return;
        busy = true;
        try {
          maybeTick(); // open runsheet screens keep the scheduler ticking during opening hours
          await sweep();
          const snap = JSON.stringify(await runsheet(day));
          if (force || snap !== last) {
            last = snap;
            write(`data: ${snap}\n\n`);
          }
        } catch (e) {
          console.error("[won] runsheet stream", e);
        } finally {
          busy = false;
        }
      };
      let pending: ReturnType<typeof setTimeout> | null = null;
      const onChange = (d: string) => {
        if (d !== day || pending) return;
        pending = setTimeout(() => {
          pending = null;
          void send();
        }, 150);
      };
      events().on("change", onChange);
      const poll = setInterval(() => void send(), POLL_MS);
      const beat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
      const end = setTimeout(() => {
        cleanup();
        try {
          controller.close();
        } catch {}
      }, STREAM_MS);
      cleanup = () => {
        closed = true;
        events().off("change", onChange);
        clearInterval(poll);
        clearInterval(beat);
        clearTimeout(end);
        if (pending) clearTimeout(pending);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
      write("retry: 1000\n\n");
      void send(true);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
});
