import { createHold, sweep } from "@/lib/bookings";
import { db } from "@/lib/db";
import { HttpError, handle, json } from "@/lib/http";
import { getProduct } from "@/lib/repo";

interface Row { id: number; day: string; hour: number; product_id: string; party_size: number; state: string; offer_start: number | null; offer_expires: number | null; phone: string; name: string }

async function load(token: string): Promise<Row> {
  const w = await db().prepare("SELECT w.*, c.phone, c.name FROM waitlist w JOIN customers c ON c.id = w.customer_id WHERE w.token = ?").get<Row>(token);
  if (!w) throw new HttpError(404, "Waitlist entry not found");
  return w;
}

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ token: string }> }) => {
  await sweep(true);
  const w = await load((await ctx.params).token);
  return json({ state: w.state, day: w.day, hour: w.hour, party: w.party_size, product: (await getProduct(w.product_id))?.name, offerStart: w.offer_start, offerExpires: w.offer_expires });
});

/** Accept the offer: places a normal 10-min hold → payment. */
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ token: string }> }) => {
  await sweep(true);
  const w = await load((await ctx.params).token);
  if (w.state !== "offered" || w.offer_start == null || (w.offer_expires ?? 0) < Date.now()) throw new HttpError(409, "This offer has expired");
  const res = await createHold({
    day: w.day, productId: w.product_id, party: w.party_size, start: w.offer_start, name: w.name, phone: w.phone,
    source: "online", payment: "online", idemKey: `waitlist:${w.id}`, actor: "customer",
  });
  await db().prepare("UPDATE waitlist SET state = 'accepted' WHERE id = ?").run(w.id);
  return json(res, 201);
});
