import type { NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { sweep } from "@/lib/bookings";
import { HttpError, handle, json } from "@/lib/http";
import { runsheet } from "@/lib/runsheet";
import { isValidDay, todayIST } from "@/lib/time";

export const GET = handle(async (req: NextRequest) => {
  await requireStaff("floor");
  await sweep();
  const day = req.nextUrl.searchParams.get("date") || todayIST();
  if (!isValidDay(day)) throw new HttpError(400, "Bad date");
  return json(await runsheet(day));
});
