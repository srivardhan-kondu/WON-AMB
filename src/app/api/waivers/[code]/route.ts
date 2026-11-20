import { z } from "zod";
import { bookingAccess } from "@/lib/access";
import { AGE_BANDS, signGroupWaiver, signWaivers } from "@/lib/bookings";
import { HttpError, body, clientIp, handle, json, rateLimit } from "@/lib/http";

const W = z.object({
  t: z.string().nullish(),
  phone: z.string().nullish(),
  /** Desk only: the lead guest accepts for every unsigned guest in the party — no individual names. */
  group: z.literal(true).optional(),
  guests: z.array(z.object({ name: z.string().trim().min(2).max(80), ageBand: z.enum(AGE_BANDS), accept: z.literal(true) })).min(1).max(40).optional(),
});

/** "No waiver, no game": one record per guest with timestamp + IP. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ code: string }> }) => {
  rateLimit(req, "waivers", 30);
  const { code } = await ctx.params;
  const w = await body(req, W);
  const { booking, staff } = await bookingAccess(code, { t: w.t, phone: w.phone });
  if (w.group) {
    if (!staff) throw new HttpError(403, "Group waivers are taken at the front desk");
    return json(await signGroupWaiver(booking.code, clientIp(req)));
  }
  if (!w.guests) throw new HttpError(400, "Add at least one guest");
  if (w.guests.some((g) => !g.accept)) throw new HttpError(400, "Each guest must accept the waiver");
  return json(await signWaivers(booking.code, w.guests, clientIp(req), staff ? "desk" : "online"));
});
