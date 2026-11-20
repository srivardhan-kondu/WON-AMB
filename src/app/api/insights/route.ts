import type { NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { RANGES, buildInsights, type RangeKey } from "@/lib/insights";

/** Owner business insights for a preset range, compared with the equal-length period before it. */
export const GET = handle(async (req: NextRequest) => {
  await requireStaff("owner");
  const q = req.nextUrl.searchParams.get("range");
  const range: RangeKey = (RANGES as readonly string[]).includes(q ?? "") ? (q as RangeKey) : "30d";
  return json(await buildInsights(range));
});
