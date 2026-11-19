import { z } from "zod";
import { quoteDay, upsellsFor } from "@/lib/bookings";
import { getStaff } from "@/lib/auth";
import { body, handle, json, rateLimit } from "@/lib/http";
import { roomNames } from "@/lib/access";
import { nowIST } from "@/lib/time";
import { getDayConfig } from "@/lib/repo";

const Q = z.object({
  product: z.string(),
  party: z.number().int().min(1).max(40),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  preferredMin: z.number().int().min(0).max(1440).nullish(),
  chosenRooms: z.array(z.string()).max(5).nullish(),
  channel: z.enum(["online", "desk"]).default("online"),
});

/** Stateless quote → top-5 offers. Only POST /api/holds touches the ledger. */
export const POST = handle(async (req: Request) => {
  rateLimit(req, "quote", 60);
  const q = await body(req, Q);
  const channel = q.channel === "desk" && (await getStaff()) ? "desk" : "online";
  // §5: "a walk-in is just a quote with window = now". At the desk, today, with no time asked for,
  // rank the soonest feasible starts first — the guest is standing at the counter.
  const { day: today, min: nowMin } = nowIST();
  // Before opening (phone bookings at 10:30), "now" means the first slot of the day.
  const preferredMin = q.preferredMin ?? (channel === "desk" && q.date === today ? Math.max(nowMin, (await getDayConfig(today)).openMin) : null);
  const { product, result } = await quoteDay({ day: q.date, productId: q.product, party: q.party, preferredMin, chosenRooms: q.chosenRooms, channel, logRejection: true });
  const names = await roomNames();
  const offers = result.offers.map((o) => ({ ...o, legs: o.legs.map((l) => ({ ...l, room: names.get(l.roomId) ?? l.roomId })) }));
  const upsells = offers[0] ? await upsellsFor(q.date, product, q.party, offers[0].start, channel) : [];
  return json({ offers, upsells, error: result.error ?? (offers.length ? null : "No slots left for this day — try another date or join the waitlist") });
});
