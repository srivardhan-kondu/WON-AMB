import type { NextRequest } from "next/server";
import { bookingAccess } from "@/lib/access";
import { holdResultFor } from "@/lib/bookings";
import { handle, json } from "@/lib/http";

/** Payment details for an open hold (order id, amount due, expiry) — used by the pay page and party deposit links. */
export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ code: string }> }) => {
  const { booking } = await bookingAccess((await ctx.params).code, req.nextUrl);
  return json(await holdResultFor(booking.code));
});
