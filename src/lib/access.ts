import { getStaff, normalizePhone, verifyBookingToken } from "./auth";
import { db } from "./db";
import { HttpError } from "./http";
import { getBookingByCode, listRooms, type BookingRow } from "./repo";

/**
 * A booking is retrievable by code + signed token (QR / WhatsApp link), code + phone, or by staff.
 * Nothing sensitive is exposed either way (§9).
 */
export async function bookingAccess(code: string, url: { searchParams: URLSearchParams } | { t?: string | null; phone?: string | null }): Promise<{ booking: BookingRow; staff: boolean }> {
  const b = await getBookingByCode(code);
  if (!b) throw new HttpError(404, "Booking not found");
  const t = "searchParams" in url ? url.searchParams.get("t") : url.t;
  const phone = "searchParams" in url ? url.searchParams.get("phone") : url.phone;
  if (verifyBookingToken(b.code, t)) return { booking: b, staff: false };
  if (phone) {
    let p: string;
    try {
      p = normalizePhone(phone);
    } catch {
      throw new HttpError(403, "Code and phone don't match");
    }
    const c = await db().prepare("SELECT phone FROM customers WHERE id = ?").get<{ phone: string }>(b.customer_id);
    if (c && c.phone === p) return { booking: b, staff: false };
    throw new HttpError(403, "Code and phone don't match");
  }
  const staff = await getStaff();
  if (staff) return { booking: b, staff: true };
  throw new HttpError(403, "Enter the phone number used for this booking");
}

export async function roomNames() {
  return new Map((await listRooms()).map((r) => [r.id, r.name]));
}
