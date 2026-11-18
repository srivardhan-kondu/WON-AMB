import type { NextRequest } from "next/server";
import { z } from "zod";
import { bookingAccess } from "@/lib/access";
import { updateGuests } from "@/lib/bookings";
import { body, handle, json, rateLimit } from "@/lib/http";
import { AGE_BANDS } from "@/lib/waiver";

const G = z.object({
  guests: z.array(z.object({ name: z.string().trim().max(60), ageBand: z.enum(AGE_BANDS).optional() })).max(40),
});

/** §6: the group leader edits the guest list until check-in; the schedule is untouched. */
export const PUT = handle(async (req: NextRequest, ctx: { params: Promise<{ code: string }> }) => {
  rateLimit(req, "guests", 20);
  const { code } = await ctx.params;
  const { booking, staff } = await bookingAccess(code, req.nextUrl);
  const { guests } = await body(req, G);
  return json({ guests: await updateGuests(booking.code, guests, staff ? "desk" : "customer") });
});
