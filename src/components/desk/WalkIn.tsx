"use client";

import { useEffect, useState } from "react";
import type { Product, Room } from "@/lib/engine/types";
import { api, newIdem } from "@/lib/client";
import { fmtMin, rupees, todayIST } from "@/lib/time";
import { ErrorNote, Field, Spinner, Stepper } from "@/components/ui";
import { OfferPicker, type DeskOffer } from "./OfferPicker";

type Pay = "cash" | "upi_counter" | "online" | "membership" | "comp";

/** Clock times offered in the time picker (20-min grid; the engine still ranks real availability around it). */
const TIME_CHOICES = Array.from({ length: (23 - 9) * 3 }, (_, i) => 9 * 60 + i * 20);

/** Walk-in: product + party → same top-5 offers → counter payment → ticket. Two taps for the common case. */
export function WalkIn({ products, rooms, onCheckIn }: { products: Product[]; rooms: Room[]; onCheckIn?: (code: string) => void }) {
  const sellable = products.filter((p) => p.shape !== "party" && p.active);
  const [productId, setProductId] = useState("c3");
  const [party, setParty] = useState(2);
  const [day, setDay] = useState(todayIST());
  /** Preferred start in minutes, or null: "next available" today / "any time" on other days. */
  const [time, setTime] = useState<number | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [offers, setOffers] = useState<DeskOffer[] | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<DeskOffer | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [pay, setPay] = useState<Pay>("upi_counter");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [membership, setMembership] = useState<{ plan: string; visits_left: number | null; valid_till: string } | null>(null);
  const [ticket, setTicket] = useState<{ code: string; token: string; status: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [idem, setIdem] = useState(newIdem());
  const product = sellable.find((p) => p.id === productId);

  useEffect(() => {
    if (!product) return;
    setParty((n) => Math.min(product.maxParty, Math.max(product.minParty, n)));
  }, [product]);

  useEffect(() => {
    if (!product) return;
    if (product.shape === "grid20" && chosen.length > 0 && chosen.length !== product.legs) return;
    let live = true;
    setOffers(null);
    setPicked(null);
    setQuoteErr(null);
    api<{ offers: DeskOffer[]; error: string | null }>("/api/quote", {
      body: { product: product.id, party, date: day, channel: "desk", preferredMin: time, chosenRooms: chosen.length ? chosen : null },
    })
      .then((d) => {
        if (!live) return;
        // "Next available" today: the server ranks around now; show them in clock order.
        // A specific time: keep the server's order (closest to the asked-for time first).
        const sorted = day === todayIST() && time == null ? [...d.offers].sort((a, b) => a.start - b.start) : d.offers;
        setOffers(sorted);
        setQuoteErr(d.error);
        if (sorted[0]) setPicked(sorted[0]);
      })
      .catch((e: Error) => live && setQuoteErr(e.message));
    return () => {
      live = false;
    };
  }, [product, party, day, time, chosen]);

  useEffect(() => {
    setMembership(null);
    if (phone.replace(/\D/g, "").length < 10) return;
    api<{ membership: { plan: string; visits_left: number | null; valid_till: string } | null }>(`/api/memberships?phone=${encodeURIComponent(phone)}`)
      .then((d) => setMembership(d.membership))
      .catch(() => {});
  }, [phone]);

  async function book() {
    if (!product || !picked) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ code: string; token: string; status: string }>("/api/desk/walkin", {
        body: { date: day, product: product.id, party, start: picked.start, chosenRooms: chosen.length ? chosen : null, name, phone, payment: pay, source: day === todayIST() ? "desk" : "phone", reason: pay === "comp" ? reason : undefined, managerPin: pay === "comp" ? pin : undefined },
        idem,
      });
      setTicket(r);
      setPin("");
      setIdem(newIdem());
    } catch (e) {
      setErr((e as Error).message);
      setIdem(newIdem());
    } finally {
      setBusy(false);
    }
  }

  if (ticket) {
    const url = `${window.location.origin}/${ticket.status === "hold" ? "pay" : "b"}/${ticket.code}?t=${ticket.token}`;
    return (
      <div className="card max-w-lg space-y-3">
        <div className="text-sm text-muted">{ticket.status === "hold" ? "Payment link created" : "Booked ✓ — WhatsApp ticket sent"}</div>
        <div className="font-mono text-3xl font-bold">{ticket.code}</div>
        <div className="break-all rounded-lg bg-panel-2 p-2 text-xs">{url}</div>
        <div className="flex flex-wrap gap-2">
          {ticket.status !== "hold" && day === todayIST() && onCheckIn && (
            <button className="btn btn-cyan" onClick={() => onCheckIn(ticket.code)}>
              Waivers & check in now
            </button>
          )}
          <a className="btn" href={url} target="_blank" rel="noreferrer">
            Open ticket
          </a>
          <button className="btn btn-primary" onClick={() => { setTicket(null); setName(""); setPhone(""); setChosen([]); setTime(null); }}>
            Next guest
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {sellable.map((p) => (
            <button key={p.id} className={`btn ${productId === p.id ? "border-pink text-pink" : ""}`} onClick={() => { setProductId(p.id); setChosen([]); }}>
              {p.name}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Party">
            {product && <Stepper value={party} min={product.minParty} max={product.maxParty} onChange={setParty} />}
          </Field>
          <Field label="Date">
            <input type="date" className="input" value={day} min={todayIST()} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label="Time">
            <select className="input" value={time ?? ""} onChange={(e) => setTime(e.target.value === "" ? null : Number(e.target.value))}>
              <option value="">{day === todayIST() ? "Next available" : "Any time"}</option>
              {TIME_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {fmtMin(m)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {product?.shape === "grid20" && (
          <div className="flex flex-wrap gap-2">
            <span className="label w-full">Games (optional · pick {product.legs})</span>
            {rooms.filter((r) => r.zone === "game").map((r) => {
              const on = chosen.includes(r.id);
              return (
                <button key={r.id} className={`btn btn-sm ${on ? "border-cyan text-cyan" : ""}`} onClick={() => setChosen((c) => (on ? c.filter((x) => x !== r.id) : c.length >= product.legs ? [...c.slice(1), r.id] : [...c, r.id]))}>
                  {r.name}
                </button>
              );
            })}
          </div>
        )}
        {offers == null && !quoteErr ? <Spinner /> : <OfferPicker offers={offers ?? []} picked={picked?.start ?? null} onPick={setPicked} />}
        <ErrorNote error={quoteErr} />
      </div>

      <div className="card space-y-3 self-start">
        <div className="label">Guest</div>
        <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="Mobile" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        {membership && (
          <div className="rounded-lg border border-lime/40 bg-lime/5 p-2 text-xs text-lime">
            Member: {membership.plan} · {membership.visits_left ?? "unlimited"} visits left · till {membership.valid_till}
          </div>
        )}
        <div className="label">Payment</div>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["upi_counter", "UPI at counter"],
              ["cash", "Cash"],
              ["online", "Send pay link"],
              ...(membership ? [["membership", "Membership visit"]] : []),
              ["comp", "Comp (manager PIN)"],
            ] as [Pay, string][]
          ).map(([k, l]) => (
            <button key={k} className={`btn btn-sm ${pay === k ? "border-cyan text-cyan" : ""}`} onClick={() => setPay(k)}>
              {l}
            </button>
          ))}
        </div>
        {pay === "comp" && (
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <input className="input" placeholder="Reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <input className="input font-mono" type="password" inputMode="numeric" autoComplete="off" placeholder="Mgr PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
          </div>
        )}
        {picked && product && (
          <div className="flex justify-between rounded-lg bg-panel-2 p-2 text-sm">
            <span>
              {product.name} × {party} @ {fmtMin(picked.start)}
            </span>
            <b className="font-mono">{pay === "membership" || pay === "comp" ? "₹0" : rupees(picked.pricePaise)}</b>
          </div>
        )}
        <ErrorNote error={err} />
        <button className="btn btn-primary w-full" disabled={busy || !picked || !name.trim() || phone.replace(/\D/g, "").length < 10 || (pay === "comp" && (reason.trim().length < 3 || pin.length < 4))} onClick={book}>
          {busy ? <Spinner /> : null} {pay === "online" ? "Hold & send pay link" : "Confirm booking"}
        </button>
      </div>
    </div>
  );
}
