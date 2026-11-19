"use client";

import { useEffect, useRef, useState } from "react";
import type { Product, Room } from "@/lib/engine/types";
import { api, newIdem } from "@/lib/client";
import { addDays, fmtMin, rupees, todayIST } from "@/lib/time";
import { ErrorNote, Spinner, Stepper } from "@/components/ui";
import { OfferPicker, type DeskOffer } from "./OfferPicker";
import { Icon } from "@/components/icons";

type Pay = "upi_counter" | "cash" | "online" | "membership" | "comp";

interface Guest {
  name: string | null;
  visits: number;
  membership: { plan: string; visits_left: number | null; valid_till: string } | null;
}

/** Clock times offered in the time picker (20-min grid; the engine still ranks real availability around it). */
const TIME_CHOICES = Array.from({ length: (23 - 9) * 3 }, (_, i) => 9 * 60 + i * 20);

const digits = (s: string) => s.replace(/\D/g, "");

/**
 * New booking at the desk, top to bottom:
 * 1 mobile + name (returning guests fill in automatically) → 2 experience → 3 guests & day → 4 time → 5 payment → Confirm.
 */
export function WalkIn({ products, rooms, onCheckIn }: { products: Product[]; rooms: Room[]; onCheckIn?: (code: string) => void }) {
  const sellable = products.filter((p) => p.shape !== "party" && p.active);
  const today = todayIST();
  const phoneRef = useRef<HTMLInputElement>(null);

  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [guest, setGuest] = useState<Guest | null>(null);
  const [productId, setProductId] = useState("c3");
  const [pickGames, setPickGames] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [party, setParty] = useState(2);
  const [day, setDay] = useState(today);
  /** Preferred start in minutes, or null: "next available" today / "any time" on other days. */
  const [time, setTime] = useState<number | null>(null);
  const [offers, setOffers] = useState<DeskOffer[] | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<DeskOffer | null>(null);
  const [payChoice, setPay] = useState<Pay>("upi_counter");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [ticket, setTicket] = useState<{ code: string; token: string; status: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [idem, setIdem] = useState(newIdem());
  const product = sellable.find((p) => p.id === productId);
  const phoneOk = digits(phone).length >= 10;
  /** "Membership" only applies while the typed number belongs to a member. */
  const pay: Pay = payChoice === "membership" && !guest?.membership ? "upi_counter" : payChoice;

  useEffect(() => {
    if (!product) return;
    setParty((n) => Math.min(product.maxParty, Math.max(product.minParty, n)));
  }, [product]);

  // Returning guest? Fill the name and show their membership.
  useEffect(() => {
    setGuest(null);
    if (!phoneOk) return;
    let live = true;
    api<Guest>(`/api/desk/guest?phone=${encodeURIComponent(phone)}`)
      .then((g) => {
        if (!live) return;
        setGuest(g);
        if (g.name) setName((n) => (n.trim() ? n : g.name!));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [phone, phoneOk]);

  useEffect(() => {
    if (!product) return;
    if (product.shape === "grid20" && chosen.length > 0 && chosen.length !== product.legs) return;
    let live = true;
    setOffers(null);
    setPicked(null);
    setQuoteErr(null);
    api<{ offers: DeskOffer[]; error: string | null }>("/api/quote", {
      body: { product: product.id, party, date: day, preferredMin: time, chosenRooms: chosen.length ? chosen : null },
    })
      .then((d) => {
        if (!live) return;
        // "Next available" today: show in clock order. A specific time: closest to it first.
        const sorted = day === today && time == null ? [...d.offers].sort((a, b) => a.start - b.start) : d.offers;
        setOffers(sorted);
        setQuoteErr(d.error);
        if (sorted[0]) setPicked(sorted[0]);
      })
      .catch((e: Error) => live && setQuoteErr(e.message));
    return () => {
      live = false;
    };
  }, [product, party, day, time, chosen, today]);

  async function book() {
    if (!product || !picked) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ code: string; token: string; status: string }>("/api/desk/walkin", {
        body: {
          date: day, product: product.id, party, start: picked.start, chosenRooms: chosen.length ? chosen : null, name: name.trim(), phone,
          payment: pay, source: day === today ? "desk" : "phone", reason: pay === "comp" ? reason : undefined, managerPin: pay === "comp" ? pin : undefined,
        },
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

  function nextGuest() {
    setTicket(null);
    setPhone("");
    setName("");
    setGuest(null);
    setChosen([]);
    setPickGames(false);
    setTime(null);
    setDay(today);
    setPay("upi_counter");
    setReason("");
    setErr(null);
    setTimeout(() => phoneRef.current?.focus(), 0);
  }

  if (ticket) {
    const url = `${window.location.origin}/${ticket.status === "hold" ? "pay" : "b"}/${ticket.code}?t=${ticket.token}`;
    const hold = ticket.status === "hold";
    return (
      <div className="card mx-auto max-w-xl space-y-6 p-8 text-center">
        <div className={`mx-auto flex h-20 w-20 items-center justify-center rounded-full ${hold ? "bg-amber/10 text-amber" : "bg-lime/10 text-lime"}`}>
          <Icon name={hold ? "clock" : "check"} className="h-12 w-12" />
        </div>
        <div>
          <div className="text-3xl font-bold">{hold ? "Payment link sent" : "Booking confirmed"}</div>
          <div className="mt-2 text-lg text-muted">
            {hold ? "The slot is held for 10 minutes while the guest pays." : "The ticket is on its way to the guest on WhatsApp."}
          </div>
        </div>
        <div className="rounded-xl bg-panel-2 py-5 font-mono text-5xl font-bold tracking-wider">{ticket.code}</div>
        <div className="grid gap-3">
          {!hold && day === today && onCheckIn && (
            <button className="btn btn-cyan btn-lg" onClick={() => onCheckIn(ticket.code)}>
              Check in now
            </button>
          )}
          <button className="btn btn-primary btn-lg" autoFocus onClick={nextGuest}>
            Next guest
          </button>
          <a className="text-base text-muted underline" href={url} target="_blank" rel="noreferrer">
            Open the guest&apos;s ticket
          </a>
        </div>
      </div>
    );
  }

  const PAY_OPTIONS: [Pay, string][] = [
    ["upi_counter", "UPI"],
    ["cash", "Cash"],
    ["online", "Send pay link"],
    ...(guest?.membership ? ([["membership", "Membership"]] as [Pay, string][]) : []),
    ["comp", "Free (manager)"],
  ];

  const missing = !phoneOk
    ? "Enter the mobile number"
    : !name.trim()
      ? "Enter the guest's name"
      : !picked
        ? "Pick a time"
        : pay === "comp" && (reason.trim().length < 3 || pin.length < 4)
          ? "Enter reason and manager PIN"
          : null;
  const total = picked ? (pay === "membership" || pay === "comp" ? 0 : picked.pricePaise) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-5 pb-36">
      {/* 1. Guest */}
      <section className="card space-y-4">
        <StepTitle n={1} title="Guest" />
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="label">Mobile number</span>
            <input
              ref={phoneRef}
              className="input input-lg font-medium tracking-wide"
              placeholder="98765 43210"
              inputMode="tel"
              autoFocus
              autoComplete="off"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="label">Name</span>
            <input className="input input-lg" placeholder="Guest name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        {guest && (guest.name || guest.membership) && (
          <div className="flex flex-wrap gap-2 text-base">
            {guest.name && (
              <span className="rounded-lg bg-cyan/10 px-3 py-1.5 font-medium text-cyan">
                Returning guest{guest.visits ? ` · ${guest.visits} visit${guest.visits === 1 ? "" : "s"}` : ""}
              </span>
            )}
            {guest.membership && (
              <span className="rounded-lg bg-lime/10 px-3 py-1.5 font-medium text-lime">
                Member · {guest.membership.plan} · {guest.membership.visits_left ?? "unlimited"} visits left
              </span>
            )}
          </div>
        )}
      </section>

      {/* 2. Experience */}
      <section className="card space-y-4">
        <StepTitle n={2} title="Experience" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sellable.map((p) => {
            const on = productId === p.id;
            return (
              <button
                key={p.id}
                className={`rounded-xl border-2 p-4 text-left transition ${on ? "border-pink bg-pink/5" : "border-line bg-panel hover:border-gray-300"}`}
                onClick={() => {
                  setProductId(p.id);
                  setChosen([]);
                  setPickGames(false);
                }}
              >
                <div className={`text-lg font-semibold ${on ? "text-pink" : ""}`}>{p.name}</div>
                <div className="mt-1 text-base text-muted">
                  {rupees(p.pricePaise)}
                  {p.pricing === "pack4" ? " for 4" : " per person"}
                </div>
              </button>
            );
          })}
        </div>
        {product?.shape === "grid20" &&
          (pickGames ? (
            <div className="space-y-3 border-t border-line pt-4">
              <div className="flex items-center justify-between">
                <span className="label mb-0">Pick {product.legs} games</span>
                <button className="text-base text-muted underline" onClick={() => { setPickGames(false); setChosen([]); }}>
                  Let the system choose
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {rooms
                  .filter((r) => r.zone === "game")
                  .map((r) => {
                    const on = chosen.includes(r.id);
                    return (
                      <button
                        key={r.id}
                        className={`btn ${on ? "border-cyan bg-cyan/10 text-cyan" : ""}`}
                        onClick={() => setChosen((c) => (on ? c.filter((x) => x !== r.id) : c.length >= product.legs ? [...c.slice(1), r.id] : [...c, r.id]))}
                      >
                        {r.name}
                      </button>
                    );
                  })}
              </div>
            </div>
          ) : (
            product.legs < rooms.filter((r) => r.zone === "game").length && (
              <button className="text-base text-cyan underline" onClick={() => setPickGames(true)}>
                Guest wants specific games?
              </button>
            )
          ))}
      </section>

      {/* 3. Guests & day */}
      <section className="card space-y-4">
        <StepTitle n={3} title="How many, and when" />
        <div className="flex flex-wrap items-end gap-6">
          <div>
            <span className="label">Guests</span>
            {product && <Stepper value={party} min={product.minParty} max={product.maxParty} onChange={setParty} />}
          </div>
          <div>
            <span className="label">Day</span>
            <div className="flex flex-wrap items-center gap-2">
              {[
                [today, "Today"],
                [addDays(today, 1), "Tomorrow"],
              ].map(([d, l]) => (
                <button key={d} className={`btn ${day === d ? "border-pink bg-pink/5 text-pink" : ""}`} onClick={() => { setDay(d); setTime(null); }}>
                  {l}
                </button>
              ))}
              <input
                type="date"
                className={`input w-auto ${day !== today && day !== addDays(today, 1) ? "border-pink text-pink" : ""}`}
                value={day}
                min={today}
                onChange={(e) => e.target.value && setDay(e.target.value)}
                aria-label="Other date"
              />
            </div>
          </div>
          <label className="block">
            <span className="label">Time</span>
            <select className="input w-auto" value={time ?? ""} onChange={(e) => setTime(e.target.value === "" ? null : Number(e.target.value))}>
              <option value="">{day === today ? "Next available" : "Any time"}</option>
              {TIME_CHOICES.map((m) => (
                <option key={m} value={m}>
                  Around {fmtMin(m)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* 4. Time */}
      <section className="card space-y-4">
        <StepTitle n={4} title="Pick a time" hint={day === today && time == null ? "Soonest first" : "Closest first"} />
        {offers == null && !quoteErr ? (
          <div className="py-8 text-center text-muted">
            <Spinner />
          </div>
        ) : (
          <OfferPicker offers={offers ?? []} picked={picked?.start ?? null} onPick={setPicked} />
        )}
        <ErrorNote error={quoteErr} />
      </section>

      {/* 5. Payment */}
      <section className="card space-y-4">
        <StepTitle n={5} title="Payment" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {PAY_OPTIONS.map(([k, l]) => (
            <button key={k} className={`btn py-4 text-lg ${pay === k ? "border-2 border-pink bg-pink/5 text-pink" : ""}`} onClick={() => setPay(k)}>
              {l}
            </button>
          ))}
        </div>
        {pay === "online" && <p className="text-base text-muted">The guest gets a UPI link on WhatsApp. The slot is held for 10 minutes.</p>}
        {pay === "comp" && (
          <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
            <input className="input" placeholder="Reason (recorded)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <input className="input font-mono" type="password" inputMode="numeric" autoComplete="off" placeholder="Manager PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
          </div>
        )}
      </section>

      {/* Confirm bar: always visible */}
      <div className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-line bg-panel/95 backdrop-blur lg:left-72">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-4 lg:px-8">
          <div className="min-w-0 flex-1 text-lg">
            <div className="truncate font-semibold">
              {name.trim() || "Guest"} · {party} {party === 1 ? "guest" : "guests"} · {product?.name ?? "—"}
            </div>
            <div className="truncate text-muted">
              {picked ? `${day === today ? "Today" : day === addDays(today, 1) ? "Tomorrow" : day}, ${fmtMin(picked.start)}` : "No time picked yet"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-muted">Total</div>
            <div className="text-3xl font-bold">{total == null ? "—" : rupees(total)}</div>
          </div>
          <button className="btn btn-primary btn-lg min-w-[260px]" disabled={busy || !!missing} onClick={book}>
            {busy ? <Spinner /> : null}
            {missing ?? (pay === "online" ? "Send pay link" : "Confirm booking")}
          </button>
          {err && (
            <div className="w-full">
              <ErrorNote error={err} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepTitle({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-pink text-base font-bold text-white">{n}</span>
      <span className="text-xl font-semibold">{title}</span>
      {hint && <span className="ml-auto text-base text-muted">{hint}</span>}
    </div>
  );
}
