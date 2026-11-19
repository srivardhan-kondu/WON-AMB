"use client";

import { useEffect, useState } from "react";
import type { Product } from "@/lib/engine/types";
import { api, newIdem } from "@/lib/client";
import { addDays, fmtMin, rupees, todayIST } from "@/lib/time";
import { ErrorNote, Field, Spinner, Stepper } from "@/components/ui";
import { OfferPicker, type DeskOffer } from "./OfferPicker";

/** Party desk (§7): exclusive zone block + 30/15-min setup/teardown + 25% deposit. */
export function PartyDesk({ products }: { products: Product[] }) {
  const parties = products.filter((p) => p.shape === "party" && p.active);
  const [productId, setProductId] = useState(parties[0]?.id ?? "");
  const [party, setParty] = useState(12);
  const [day, setDay] = useState(addDays(todayIST(), 3));
  const [offers, setOffers] = useState<DeskOffer[] | null>(null);
  const [picked, setPicked] = useState<DeskOffer | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [food, setFood] = useState(false);
  const [notes, setNotes] = useState("");
  const [payment, setPayment] = useState<"online" | "cash" | "upi_counter">("online");
  const [override, setOverride] = useState(false);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ code: string; token: string; status: string; amountDuePaise: number } | null>(null);
  const product = parties.find((p) => p.id === productId);

  useEffect(() => {
    if (!productId && parties[0]) setProductId(parties[0].id);
  }, [parties, productId]);

  useEffect(() => {
    if (!product) return;
    setParty((n) => Math.min(product.maxParty, Math.max(product.minParty, n)));
  }, [product]);

  useEffect(() => {
    if (!product) return;
    let live = true;
    setOffers(null);
    setPicked(null);
    api<{ offers: DeskOffer[]; error: string | null }>("/api/quote", { body: { product: product.id, party, date: day, channel: "desk" } })
      .then((d) => {
        if (!live) return;
        setOffers([...d.offers].sort((a, b) => a.start - b.start));
        setErr(d.error);
      })
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [product, party, day]);

  async function create() {
    if (!product || !picked) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ code: string; token: string; status: string; amountDuePaise: number }>("/api/party-bookings", {
        body: { date: day, product: product.id, party, start: picked.start, name, phone, food, notes, payment, overrideLead: override, managerPin: override ? pin : undefined },
        idem: newIdem(),
      });
      setDone(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const link = `${window.location.origin}/pay/${done.code}?t=${done.token}`;
    return (
      <div className="card max-w-lg space-y-3">
        <div className="text-2xl font-semibold tracking-tight">{done.code}</div>
        {done.status === "hold" ? (
          <>
            <div className="text-base">
              Zone held for 2 h. Send this deposit link ({rupees(done.amountDuePaise)}):
            </div>
            <div className="break-all rounded-lg bg-panel-2 p-2 text-sm">{link}</div>
            <button className="btn" onClick={() => navigator.clipboard.writeText(link)}>
              Copy link
            </button>
          </>
        ) : (
          <div className="text-lime">Party confirmed ✓ — deposit recorded.</div>
        )}
        <button className="btn btn-primary" onClick={() => setDone(null)}>
          New party
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {parties.map((p) => (
            <button key={p.id} className={`btn ${productId === p.id ? "border-pink text-pink" : ""}`} onClick={() => setProductId(p.id)}>
              {p.name} · {rupees(p.pricePaise)}/pp
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Guests">{product && <Stepper value={party} min={product.minParty} max={product.maxParty} onChange={setParty} />}</Field>
          <Field label="Date" hint="≥ 48 h ahead">
            <input type="date" className="input" value={day} min={todayIST()} onChange={(e) => setDay(e.target.value)} />
          </Field>
        </div>
        {offers == null ? <Spinner /> : <OfferPicker offers={offers} picked={picked?.start ?? null} onPick={setPicked} />}
        {offers?.length === 0 && <div className="text-base text-muted">No exclusive block free that day.</div>}
      </div>
      <div className="card space-y-3 self-start">
        <input className="input" placeholder="Host name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="Host mobile" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <label className="flex items-center gap-2 text-base">
          <input type="checkbox" checked={food} onChange={(e) => setFood(e.target.checked)} /> Food add-on (flags vendor timeline on runsheet)
        </label>
        <textarea className="input" rows={2} placeholder="Notes (cake, theme…)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="grid grid-cols-3 gap-2">
          {(["online", "upi_counter", "cash"] as const).map((k) => (
            <button key={k} className={`btn btn-sm ${payment === k ? "border-cyan text-cyan" : ""}`} onClick={() => setPayment(k)}>
              {k === "online" ? "Deposit link" : k === "cash" ? "Cash" : "UPI"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-amber">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Override 48 h notice rule (manager PIN, audited)
        </label>
        {override && <input className="input font-mono" type="password" inputMode="numeric" autoComplete="off" placeholder="Manager PIN" value={pin} onChange={(e) => setPin(e.target.value)} />}
        {picked && product && (
          <div className="rounded-lg bg-panel-2 p-2 text-base">
            <div className="flex justify-between">
              <span>
                {party} × {rupees(product.pricePaise)} @ {fmtMin(picked.start)}
              </span>
              <b className="tabular-nums">{rupees(picked.pricePaise)}</b>
            </div>
            <div className="text-sm text-muted">Deposit 25%: {rupees(Math.round(picked.pricePaise * 0.25))} · setup 30 min before, teardown 15 after</div>
          </div>
        )}
        <ErrorNote error={err} />
        <button className="btn btn-primary w-full" disabled={busy || !picked || !name || phone.replace(/\D/g, "").length < 10 || (override && pin.length < 4)} onClick={create}>
          Create party booking
        </button>
      </div>
    </div>
  );
}
