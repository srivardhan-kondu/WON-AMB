import { requireStaff } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { listProducts } from "@/lib/repo";

export const GET = handle(async () => {
  await requireStaff("desk");
  return json({ products: listProducts(true) });
});
