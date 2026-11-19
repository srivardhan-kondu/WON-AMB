"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Product, Room } from "@/lib/engine/types";
import { ApiError, api, newIdem } from "@/lib/client";
import { addDays, fmtDay, fmtMin, rupees, todayIST } from "@/lib/time";
import { ErrorNote, Field, Spinner, Stepper } from "./ui";

interface OfferView {
  start: number;
  end: number;
  peak: boolean;
  pricePaise: number;
  basePricePaise?: number;
  flash?: boolean;
  score: number;
  legs: { roomId: string; room: string; start: number; end: number }[];
}
interface Upsell {
  productId: string;
  name: string;
  start: number;
  extraPaise: number;
}

function priceLabel(p: Product) {
  return p.pricing === "pack4" ? `${rupees(p.pricePaise)} / 4 people` : `${rupees(p.pricePaise)} / person`;
}

export default function BookingWizard() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [productId, setProductId] = useState<string>("");
  const [party, setParty] = useState(2);
  const [chosen, setChosen] = useState<string[]>([]);
  const [day, setDay] = useState(todayIST());
  const [days, setDays] = useState<{ day: string; slots: number; peak: boolean }[]>([]);
  const [preferred, setPreferred] = useState<number | null>(null);
  const [offers, setOffers] = useState<OfferView[] | null>(null);
  const [upsells, setUpsells] = useState<Upsell[]>([]);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<OfferView | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [idem, setIdem] = useState(newIdem());
  const [waitlistDone, setWaitlistDone] = useState(false);

  const product = products.find((p) => p.id === productId);
  const gameRooms = rooms.filter((r) => r.zone === "game");
  const needsChoice = product?.shape === "grid20" && product.legs < 5;

  useEffect(() => {
    api<{ products: Product[]; rooms: Room[] }>("/api/products").then((d) => {
      setProducts(d.products);
      setRooms(d.rooms);
      const pre = new URLSearchParams(window.location.search).get("product");
      if (pre && d.products.some((p) => p.id === pre)) setProductId(pre);
    });
  }, []);

  // Clamp party size to product rules.
  useEffect(() => {
    if (!product) return;
    setParty((n) => Math.min(product.maxParty, Math.max(product.minParty, n)));
    setChosen([]);
  }, [product]);

  // Day heat strip.
  useEffect(() => {
    if (!product) return;
    let live = true;
    api<{ days: { day: string; slots: number; peak: boolean }[] }>(`/api/availability?product=${product.id}&party=${party}&days=14`).then((d) => live && setDays(d.days));
    return () => {
      live = false;
    };
  }, [product, party]);

  // Quote whenever inputs change.
  useEffect(() => {
    if (!product) return;
    if (needsChoice && chosen.length > 0 && chosen.length !== product.legs) {
      setOffers(null);
      return;
    }
    let live = true;
    setOffers(null);
    setPicked(null);
    setQuoteErr(null);
    api<{ offers: OfferView[]; upsells: Upsell[]; error: string | null }>("/api/quote", {
      body: { product: product.id, party, date: day, preferredMin: preferred, chosenRooms: chosen.length ? chosen : null },
    })
      .then((d) => {
        if (!live) return;
        setOffers(d.offers);
        setUpsells(d.upsells);
        setQuoteErr(d.error);
      })
      .catch((e: Error) => live && setQuoteErr(e.message));
    return () => {
      live = false;
    };
  }, [product, party, day, preferred, chosen, needsChoice]);

  const timeOptions = useMemo(() => {
    const out: number[] = [];
    for (let m = 11 * 60; m <= 21 * 60; m += 60) out.push(m);
    return out;
  }, []);

  async function hold() {
    if (!product || !picked) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ code: string; token: string; status: string }>("/api/holds", {
        body: { product: product.id, party, date: day, start: picked.start, chosenRooms: chosen.length ? chosen : null, name, phone },
        idem,
      });
      router.push(res.status === "hold" ? `/pay/${res.code}?t=${res.token}` : `/b/${res.code}?t=${res.token}`);
    } catch (e) {
      setIdem(newIdem());
      if (e instanceof ApiError && e.status === 409) {
        setErr("Someone just took that slot — here are the next best options.");
        setPicked(null);
        setOffers(null);
        const d = await api<{ offers: OfferView[]; upsells: Upsell[]; error: string | null }>("/api/quote", {
          body: { product: product.id, party, date: day, preferredMin: picked.start, chosenRooms: chosen.length ? chosen : null },
        });
        setOffers(d.offers);
      } else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function joinWaitlist() {
    if (!product) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/api/waitlist", { body: { date: day, hour: Math.floor((preferred ?? 18 * 60) / 60), product: product.id, party, name, phone } });
      setWaitlistDone(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* 1. Product */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">1 · Pick your experience</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {products.map((p) => (
            <button
              key={p.id}
              onClick={() => setProductId(p.id)}
              className={`card text-left transition hover:border-pink/60 ${productId === p.id ? "border-pink shadow-[0_0_30px_-12px_var(--pink)]" : ""}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="font-semibold">{p.name}</div>
                <div className="whitespace-nowrap text-sm font-semibold tabular-nums text-pink">{priceLabel(p)}</div>
              </div>
              <div className="mt-1 text-sm text-muted">{p.description}</div>
            </button>
          ))}
          {products.length === 0 && (
            <div className="text-muted">
              <Spinner /> Loading…
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">Birthdays & corporate events (10+ guests): WhatsApp our party desk.</p>
      </section>

      {product && (
        <>
          {/* 2. Party & games */}
          <section className="card space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">2 · Who&apos;s coming</h2>
            <div className="flex flex-wrap items-center gap-4">
              <Stepper value={party} min={product.minParty} max={product.maxParty} onChange={setParty} />
              <span className="text-sm text-muted">
                {party} {party === 1 ? "guest" : "guests"} · {rupees(product.pricing === "pack4" ? product.pricePaise + Math.max(0, party - 4) * product.extraPaise : product.pricePaise * party)}
              </span>
            </div>
            {needsChoice && (
              <div>
                <div className="label">Choose {product.legs === 1 ? "your game" : `your ${product.legs} games`} (optional — we&apos;ll pick the best order)</div>
                <div className="flex flex-wrap gap-2">
                  {gameRooms.map((r) => {
                    const on = chosen.includes(r.id);
                    return (
                      <button
                        key={r.id}
                        className={`btn btn-sm ${on ? "border-cyan text-cyan" : ""}`}
                        onClick={() =>
                          setChosen((c) => (on ? c.filter((x) => x !== r.id) : c.length >= product.legs ? [...c.slice(1), r.id] : [...c, r.id]))
                        }
                      >
                        {r.name}
                      </button>
                    );
                  })}
                </div>
                {chosen.length > 0 && chosen.length !== product.legs && <p className="mt-2 text-xs text-amber">Pick {product.legs - chosen.length} more, or clear to let us choose.</p>}
              </div>
            )}
          </section>

          {/* 3. Date & time */}
          <section className="card space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">3 · When</h2>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {(days.length ? days : Array.from({ length: 14 }, (_, i) => ({ day: addDays(todayIST(), i), slots: -1, peak: false }))).map((d) => (
                <button
                  key={d.day}
                  onClick={() => setDay(d.day)}
                  className={`min-w-[78px] rounded-xl border px-2 py-2 text-center text-xs transition ${day === d.day ? "border-pink bg-pink/10" : "border-line hover:border-cyan/50"}`}
                >
                  <div className="font-semibold">{fmtDay(d.day).split(",")[0]}</div>
                  <div className="text-muted">{fmtDay(d.day).split(",")[1] ?? fmtDay(d.day)}</div>
                  <div className={`mt-1 h-1 rounded-full ${d.slots < 0 ? "bg-line" : d.slots === 0 ? "bg-red/70" : d.slots < 4 ? "bg-amber" : "bg-lime"}`} />
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button className={`btn btn-sm ${preferred == null ? "border-cyan text-cyan" : ""}`} onClick={() => setPreferred(null)}>
                Any time
              </button>
              {timeOptions.map((m) => (
                <button key={m} className={`btn btn-sm ${preferred === m ? "border-cyan text-cyan" : ""}`} onClick={() => setPreferred(m)}>
                  ~{fmtMin(m)}
                </button>
              ))}
            </div>
          </section>

          {/* 4. Offers */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">4 · Pick a slot</h2>
            {offers == null && !quoteErr && (
              <div className="text-sm text-muted">
                <Spinner /> Finding the best slots…
              </div>
            )}
            {offers?.map((o, i) => (
              <button
                key={o.start}
                onClick={() => setPicked(o)}
                className={`card w-full text-left transition hover:border-cyan/60 ${picked?.start === o.start ? "border-cyan shadow-[0_0_30px_-12px_var(--cyan)]" : ""}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-lg font-semibold">
                    {fmtMin(o.start)} – {fmtMin(o.end)}
                  </div>
                  <div className="flex items-center gap-2">
                    {i === 0 && <span className="chip border-pink/50 text-pink">best match</span>}
                    {o.flash && <span className="chip border-amber/60 text-amber">flash price</span>}
                    {!o.peak && !o.flash && <span className="chip border-lime/50 text-lime">off-peak · quieter</span>}
                    {o.basePricePaise && <span className="text-xs tabular-nums text-muted line-through">{rupees(o.basePricePaise)}</span>}
                    <span className="font-semibold tabular-nums">{rupees(o.pricePaise)}</span>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted">
                  {dedupeLegs(o.legs).map((l, k) => (
                    <span key={k} className="flex items-center gap-1">
                      {k > 0 && <span className="text-line">→</span>}
                      <span className="rounded-md bg-panel-2 px-2 py-0.5">
                        {fmtMin(l.start)} {l.room}
                      </span>
                    </span>
                  ))}
                </div>
              </button>
            ))}
            {upsells.length > 0 && offers && offers.length > 0 && (
              <div className="rounded-xl border border-pink/40 bg-pink/5 p-3 text-sm">
                {upsells.map((u) => (
                  <div key={u.productId} className="flex items-center justify-between gap-2">
                    <span>
                      Upgrade to <b>{u.name}</b> at {fmtMin(u.start)} for <b className="text-pink">+{rupees(u.extraPaise)}</b>
                    </span>
                    <button className="btn btn-sm" onClick={() => setProductId(u.productId)}>
                      Switch
                    </button>
                  </div>
                ))}
              </div>
            )}
            <ErrorNote error={quoteErr} />
            {offers && offers.length === 0 && (
              <div className="card space-y-3">
                <div className="font-semibold">Fully booked — join the waitlist</div>
                <p className="text-sm text-muted">If a seat frees up {preferred != null ? `around ${fmtMin(preferred)}` : "this evening"}, we&apos;ll WhatsApp you a link to grab it (10 minutes to accept).</p>
                {waitlistDone ? (
                  <div className="text-lime">You&apos;re on the list ✓</div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <input className="input" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
                    <input className="input" placeholder="Mobile number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
                    <button className="btn btn-cyan" disabled={busy || !name || phone.length < 10} onClick={joinWaitlist}>
                      Join waitlist
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 5. Details */}
          {picked && (
            <section className="card space-y-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">5 · Your details</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name (group leader)">
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                </Field>
                <Field label="WhatsApp number" hint="Confirmation, QR and waiver links go here">
                  <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="98765 43210" />
                </Field>
              </div>
              <div className="rounded-xl bg-panel-2 p-3 text-sm">
                <div className="flex justify-between">
                  <span>
                    {product.name} × {party} · {fmtDay(day)}, {fmtMin(picked.start)}
                  </span>
                  <b className="tabular-nums">{rupees(picked.pricePaise)}</b>
                </div>
                <div className="mt-1 text-xs text-muted">Incl. GST · Non-refundable · One free reschedule up to 24 h before · Waivers required for every guest</div>
              </div>
              <ErrorNote error={err} />
              <button className="btn btn-primary w-full py-3 text-base" disabled={busy || !name.trim() || phone.replace(/\D/g, "").length < 10} onClick={hold}>
                {busy ? <Spinner /> : null} Hold for 10 min & pay {rupees(picked.pricePaise)}
              </button>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Splatter legs run in two rooms at once — show them as one stop. */
function dedupeLegs(legs: OfferView["legs"]) {
  const out: OfferView["legs"] = [];
  for (const l of legs) {
    const prev = out[out.length - 1];
    if (prev && prev.start === l.start && prev.end === l.end) prev.room = `${prev.room} + ${l.room}`;
    else out.push({ ...l });
  }
  return out;
}
