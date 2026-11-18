import { getStaff } from "@/lib/auth";
import { handle, json } from "@/lib/http";

export const GET = handle(async () => {
  const s = await getStaff();
  return s ? json(s) : json({ error: "Not logged in" }, 401);
});
