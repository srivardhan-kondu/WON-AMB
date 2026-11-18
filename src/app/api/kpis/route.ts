import type { NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { weekKpis } from "@/lib/kpi";
import { addDays, isValidDay, todayIST, weekStart } from "@/lib/time";

export const GET = handle(async (req: NextRequest) => {
  await requireStaff("manager");
  const q = req.nextUrl.searchParams.get("week");
  const ws = weekStart(q && isValidDay(q) ? q : todayIST());
  return json({ current: await weekKpis(ws), previous: await weekKpis(addDays(ws, -7)) });
});
