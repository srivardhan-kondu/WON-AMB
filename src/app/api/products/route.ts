import { handle, json } from "@/lib/http";
import { listProducts, listRooms } from "@/lib/repo";
import { payments } from "@/lib/payments";

export const GET = handle(async () => {
  const p = payments();
  const [all, rooms] = await Promise.all([listProducts(), listRooms()]);
  return json({
    products: all.filter((x) => x.shape !== "party"),
    parties: all.filter((x) => x.shape === "party"),
    rooms,
    payment: { provider: p.name, keyId: p.publicKey },
  });
});
