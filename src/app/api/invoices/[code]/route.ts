import type { NextRequest } from "next/server";
import { bookingAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { HttpError, handle, json } from "@/lib/http";
import { getProduct } from "@/lib/repo";

export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ code: string }> }) => {
  const { booking } = await bookingAccess((await ctx.params).code, req.nextUrl);
  const inv = db().prepare("SELECT * FROM invoices WHERE booking_id = ?").get(booking.id) as { number: string; gst_detail: string; created_at: number } | undefined;
  if (!inv) throw new HttpError(404, "No invoice for this booking yet");
  const cust = db().prepare("SELECT name, phone FROM customers WHERE id = ?").get(booking.customer_id) as { name: string; phone: string } | undefined;
  return json({
    number: inv.number, issuedAt: inv.created_at, gst: JSON.parse(inv.gst_detail), code: booking.code, day: booking.day, start: booking.start_min,
    party: booking.party_size, product: getProduct(booking.product_id)?.name, customer: cust?.name ?? "", paidPaise: booking.paid_paise,
    seller: { name: process.env.WON_LEGAL_NAME || "World of Neon (WON)", address: "Level 6, AMB Mall", gstin: process.env.WON_GSTIN || "GSTIN-NOT-SET" },
  });
});
