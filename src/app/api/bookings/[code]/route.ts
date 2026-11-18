import type { NextRequest } from "next/server";
import { bookingAccess } from "@/lib/access";
import { bookingView, sweep } from "@/lib/bookings";
import { handle, json, rateLimit } from "@/lib/http";

export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ code: string }> }) => {
  rateLimit(req, "booking-view", 60);
  await sweep();
  const { code } = await ctx.params;
  const { booking } = await bookingAccess(code, req.nextUrl);
  return json(await bookingView(booking, { withQr: true }));
});
