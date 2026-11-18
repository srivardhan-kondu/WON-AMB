import { z } from "zod";
import { bookingAccess } from "@/lib/access";
import { AGE_BANDS, signWaivers } from "@/lib/bookings";
import { HttpError, body, clientIp, handle, json, rateLimit } from "@/lib/http";

const W = z.object({
  t: z.string().nullish(),
  phone: z.string().nullish(),
  guests: z.array(z.object({ name: z.string().trim().min(2).max(80), ageBand: z.enum(AGE_BANDS), accept: z.literal(true) })).min(1).max(40),
});

/** "No waiver, no game": one record per guest with timestamp + IP. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ code: string }> }) => {
  rateLimit(req, "waivers", 30);
  const { code } = await ctx.params;
  const w = await body(req, W);
  const { booking, staff } = await bookingAccess(code, { t: w.t, phone: w.phone });
  if (w.guests.some((g) => !g.accept)) throw new HttpError(400, "Each guest must accept the waiver");
  return json(await signWaivers(booking.code, w.guests, clientIp(req), staff ? "desk" : "online"));
});
