import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { body, handle, json } from "@/lib/http";
import { audit } from "@/lib/repo";
import { saveYieldSettings, yieldSettings } from "@/lib/yield";

export const GET = handle(async () => {
  await requireStaff("manager");
  return json(yieldSettings());
});

const Y = z.object({
  flashAuto: z.boolean(),
  flashProduct: z.string(),
  flashPricePaise: z.number().int().min(100),
  flashThreshold: z.number().min(0).max(1),
  flashHours: z.tuple([z.number().int().min(0).max(23), z.number().int().min(1).max(24)]),
  memberPeakHorizonDays: z.number().int().min(0).max(60),
  memberOffpeakHorizonDays: z.number().int().min(0).max(60),
});

export const PUT = handle(async (req: Request) => {
  const staff = await requireStaff("owner");
  const y = await body(req, Y);
  saveYieldSettings(y);
  audit(staff.email, "yield_settings_updated", "settings", y);
  return json(yieldSettings());
});
