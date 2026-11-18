import { handle, json } from "@/lib/http";
import { listProducts, listRooms } from "@/lib/repo";
import { payments } from "@/lib/payments";

export const GET = handle(async () => {
  const p = payments();
  return json({
    products: listProducts().filter((x) => x.shape !== "party"),
    parties: listProducts().filter((x) => x.shape === "party"),
    rooms: listRooms(),
    payment: { provider: p.name, keyId: p.publicKey },
  });
});
