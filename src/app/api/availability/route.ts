import type { NextRequest } from "next/server";
import { quoteDay } from "@/lib/bookings";
import { HttpError, handle, json, rateLimit } from "@/lib/http";
import { addDays, isValidDay, todayIST } from "@/lib/time";

/** Heat view for the date picker: number of feasible starts per day (?days=14) or per hour (?date=). */
export const GET = handle(async (req: NextRequest) => {
  rateLimit(req, "availability", 60);
  const u = req.nextUrl.searchParams;
  const product = u.get("product") ?? "";
  const party = Number(u.get("party") ?? 1);
  const channel = u.get("channel") === "desk" ? "desk" : "online";
  const date = u.get("date");
  if (date) {
    if (!isValidDay(date)) throw new HttpError(400, "Bad date");
    const { result, ledger } = await quoteDay({ day: date, productId: product, party, channel, limit: 1000 });
    const hours: Record<number, number> = {};
    for (let h = Math.floor(ledger.cfg.openMin / 60); h * 60 < ledger.cfg.closeMin; h++) hours[h] = 0;
    for (const o of result.offers) hours[Math.floor(o.start / 60)] = (hours[Math.floor(o.start / 60)] ?? 0) + 1;
    return json({ date, hours, peakHours: ledger.cfg.peakHours, error: result.error ?? null });
  }
  const n = Math.min(21, Number(u.get("days") ?? 14));
  const today = todayIST();
  const days = [];
  for (let i = 0; i < n; i++) {
    const day = addDays(today, i);
    const { result, ledger } = await quoteDay({ day, productId: product, party, channel, limit: 1000 });
    days.push({ day, slots: result.offers.length, peak: ledger.cfg.peakHours.length > 0, error: result.error ?? null });
  }
  return json({ days });
});
