"use client";

import { useEffect, useState } from "react";
import type { Product, Room } from "@/lib/engine/types";
import { api, newIdem } from "@/lib/client";
import { fmtMin, rupees, todayIST } from "@/lib/time";
import { ErrorNote, Field, Spinner, Stepper } from "@/components/ui";
import { OfferPicker, type DeskOffer } from "./OfferPicker";
import { Icon } from "@/components/icons";

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
    const hold = ticket.status === "hold";
    return (
      <div className="card mx-auto max-w-lg space-y-4 text-center">
        <div className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${hold ? "bg-amber/10 text-amber" : "bg-lime/10 text-lime"}`}>
          <Icon name={hold ? "clock" : "check"} className="h-7 w-7" />
        </div>
        <div>
          <div className="text-lg font-semibold">{hold ? "Payment link created" : "Booking confirmed"}</div>
          <div className="text-sm text-muted">{hold ? "The slot is held for 10 minutes while the guest pays." : "The WhatsApp ticket is on its way to the guest."}</div>
        </div>
        <div className="rounded-lg bg-panel-2 py-3 font-mono text-3xl font-bold tracking-wider">{ticket.code}</div>
        <div className="break-all text-left text-xs text-muted">{url}</div>
        <div className="flex flex-wrap justify-center gap-2">
          {!hold && day === todayIST() && onCheckIn && (
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

  const PAY_OPTIONS = [
    ["upi_counter", "UPI at counter"],
    ["cash", "Cash"],
    ["online", "Send pay link"],
    ...(membership ? [["membership", "Membership visit"]] : []),
    ["comp", "Complimentary"],
  ] as [Pay, string][];

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div className="space-y-5">
        <section className="card space-y-3">
          <StepTitle n={1} title="Experience" />
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {sellable.map((p) => {
              const on = productId === p.id;
              return (
                <button
                  key={p.id}
                  className={`rounded-lg border p-3 text-left transition ${on ? "border-pink bg-pink/5 ring-2 ring-pink/15" : "border-line bg-panel hover:border-gray-300"}`}
                  onClick={() => { setProductId(p.id); setChosen([]); }}
                >
                  <div className={`text-sm font-semibold ${on ? "text-pink" : ""}`}>{p.name}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {rupees(p.pricePaise)}
                    {p.pricing === "pack4" ? " for 4" : " / person"}
                  </div>
                </button>
              );
            })}
          </div>
          {product?.shape === "grid20" && (
            <div className="space-y-2 border-t border-line pt-3">
              <div className="label">Games (optional — pick {product.legs}, or leave empty and the system picks the best rooms)</div>
              <div className="flex flex-wrap gap-2">
                {rooms.filter((r) => r.zone === "game").map((r) => {
                  const on = chosen.includes(r.id);
                  return (
                    <button key={r.id} className={`btn btn-sm ${on ? "border-cyan bg-cyan/5 text-cyan" : ""}`} onClick={() => setChosen((c) => (on ? c.filter((x) => x !== r.id) : c.length >= product.legs ? [...c.slice(1), r.id] : [...c, r.id]))}>
                      {r.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <section className="card space-y-3">
          <StepTitle n={2} title="Party, date & time" />
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Guests">
              {product && <Stepper value={party} min={product.minParty} max={product.maxParty} onChange={setParty} />}
            </Field>
            <Field label="Date">
              <input type="date" className="input" value={day} min={todayIST()} onChange={(e) => setDay(e.target.value)} />
            </Field>
            <Field label="Preferred time">
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
        </section>

        <section className="card space-y-3">
          <StepTitle n={3} title="Choose a slot" hint={day === todayIST() && time == null ? "Soonest first" : "Closest to the requested time first"} />
          {offers == null && !quoteErr ? (
            <div className="py-6 text-center text-muted"><Spinner /></div>
          ) : (
            <OfferPicker offers={offers ?? []} picked={picked?.start ?? null} onPick={setPicked} />
          )}
          <ErrorNote error={quoteErr} />
        </section>
      </div>

      <aside className="card space-y-4 self-start lg:sticky lg:top-20">
        <StepTitle n={4} title="Guest & payment" />
        <div className="space-y-2">
          <input className="input" placeholder="Guest name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" placeholder="Mobile number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        {membership && (
          <div className="rounded-lg border border-lime/20 bg-lime/5 p-2.5 text-xs text-lime">
            <b>Member</b> · {membership.plan} · {membership.visits_left ?? "unlimited"} visits left · valid till {membership.valid_till}
          </div>
        )}
        <div>
          <div className="label">Payment</div>
          <div className="grid grid-cols-2 gap-2">
            {PAY_OPTIONS.map(([k, l]) => (
              <button key={k} className={`btn btn-sm ${pay === k ? "border-pink bg-pink/5 text-pink" : ""}`} onClick={() => setPay(k)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        {pay === "comp" && (
          <div className="grid grid-cols-[1fr_110px] gap-2">
            <input className="input" placeholder="Reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <input className="input font-mono" type="password" inputMode="numeric" autoComplete="off" placeholder="Mgr PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
          </div>
        )}
        <div className="space-y-1.5 rounded-lg bg-panel-2 p-3 text-sm">
          <Row k="Experience" v={product?.name ?? "—"} />
          <Row k="Guests" v={String(party)} />
          <Row k="When" v={picked ? `${day === todayIST() ? "Today" : day}, ${fmtMin(picked.start)}` : "Pick a slot"} />
          <div className="flex items-baseline justify-between border-t border-line pt-1.5">
            <span className="font-medium">Total</span>
            <b className="text-lg">{picked ? (pay === "membership" || pay === "comp" ? "₹0" : rupees(picked.pricePaise)) : "—"}</b>
          </div>
        </div>
        <ErrorNote error={err} />
        <button className="btn btn-primary w-full py-2.5" disabled={busy || !picked || !name.trim() || phone.replace(/\D/g, "").length < 10 || (pay === "comp" && (reason.trim().length < 3 || pin.length < 4))} onClick={book}>
          {busy ? <Spinner /> : null} {pay === "online" ? "Hold slot & send pay link" : "Confirm booking"}
        </button>
      </aside>
    </div>
  );
}

function StepTitle({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-pink/10 text-xs font-semibold text-pink">{n}</span>
      <span className="card-title">{title}</span>
      {hint && <span className="ml-auto text-xs text-muted">{hint}</span>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  );
}
