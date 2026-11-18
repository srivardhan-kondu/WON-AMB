import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { checkIn } from "@/lib/bookings";
import { body, handle, json } from "@/lib/http";

/** QR or code → verify waivers → arrived; burns a membership visit. */
export const POST = handle(async (req: Request) => {
  const staff = await requireStaff("desk");
  const c = await body(req, z.object({ scan: z.string().min(4), shrinkTo: z.number().int().min(1).nullish() }));
  return json(checkIn(c.scan, staff.email, { shrinkTo: c.shrinkTo }));
});
