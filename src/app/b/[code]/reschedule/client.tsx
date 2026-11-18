"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CustomerShell, PhoneGate } from "@/components/Shell";
import { ErrorNote, Spinner } from "@/components/ui";
import { useBooking } from "@/components/useBooking";
import { ApiError, api } from "@/lib/client";
import { addDays, fmtDay, fmtMin, todayIST } from "@/lib/time";

interface Offer {
  start: number;
  end: number;
  legs: { room: string; start: number }[];
}

export default function ReschedulePage() {
  const { code } = useParams<{ code: string }>();
  const { booking: b, error, needPhone, submitPhone, token } = useBooking(code);
  const [phone, setPhone] = useState("");
  const [otpSent, setOtpSent] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [verified, setVerified] = useState(false);
  const [day, setDay] = useState(addDays(todayIST(), 1));
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!verified || !b) return;
    setOffers(null);
    api<{ offers: Offer[] }>(`/api/bookings/${b.code}/reschedule`, { body: { date: day } })
      .then((d) => setOffers(d.offers))
      .catch((e: ApiError) => {
        if (e.status === 401) setVerified(false);
        setErr(e.message);
      });
  }, [verified, day, b]);

  if (needPhone) return <CustomerShell><PhoneGate onSubmit={submitPhone} error={error} /></CustomerShell>;
  if (!b) return <CustomerShell>{error ? <ErrorNote error={error} /> : <Spinner />}</CustomerShell>;

  if (!b.canReschedule && !done)
    return (
      <CustomerShell>
        <div className="card space-y-2">
          <div className="font-semibold">Reschedule not available</div>
          <p className="text-sm text-muted">
            {b.rescheduleCount > 0 ? "The one free reschedule has been used." : "Free reschedules close 24 h before your slot."} Please contact the front desk.
          </p>
          <Link href={`/b/${b.code}?t=${token}`} className="btn">
            Back
          </Link>
        </div>
      </CustomerShell>
    );

  async function sendOtp() {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ devCode?: string }>("/api/otp/send", { body: { phone } });
      setOtpSent(r.devCode ?? "");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setErr(null);
    try {
      await api("/api/otp/verify", { body: { phone, code: otp } });
      setVerified(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function move(start: number) {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/bookings/${b!.code}/reschedule`, { body: { date: day, start } });
      setDone(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <CustomerShell>
      <div className="space-y-4">
        <div className="card">
          <div className="text-sm text-muted">Move booking {b.code}</div>
          <div className="font-semibold">
            {b.product.name} · currently {fmtDay(b.day)}, {fmtMin(b.start)}
          </div>
          <p className="mt-1 text-xs text-muted">One free move to an equal-value slot. It can&apos;t be undone.</p>
        </div>
        {done ? (
          <div className="card border-lime/40 space-y-3 text-center">
            <div className="text-lime">Moved ✓ — a new confirmation is on its way to WhatsApp.</div>
            <Link href={`/b/${b.code}?t=${token}`} className="btn">
              View booking
            </Link>
          </div>
        ) : !verified ? (
          <div className="card space-y-3">
            <div className="label">Verify your phone</div>
            <input className="input" inputMode="tel" placeholder="Mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} />
            {otpSent == null ? (
              <button className="btn btn-cyan w-full" disabled={busy || phone.replace(/\D/g, "").length < 10} onClick={sendOtp}>
                Send code on WhatsApp
              </button>
            ) : (
              <>
                {otpSent && <div className="text-xs text-amber">Test mode code: {otpSent}</div>}
                <input className="input font-mono tracking-[0.4em]" inputMode="numeric" maxLength={6} placeholder="••••••" value={otp} onChange={(e) => setOtp(e.target.value)} />
                <button className="btn btn-primary w-full" disabled={otp.length !== 6} onClick={verify}>
                  Verify
                </button>
              </>
            )}
            <ErrorNote error={err} />
          </div>
        ) : (
          <div className="card space-y-3">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {Array.from({ length: 14 }, (_, i) => addDays(todayIST(), i + 1)).map((d) => (
                <button key={d} onClick={() => setDay(d)} className={`min-w-[84px] rounded-xl border px-2 py-2 text-xs ${day === d ? "border-pink bg-pink/10" : "border-line"}`}>
                  {fmtDay(d)}
                </button>
              ))}
            </div>
            {offers == null ? (
              <Spinner />
            ) : offers.length === 0 ? (
              <div className="text-sm text-muted">No equal-value slots that day.</div>
            ) : (
              offers.map((o) => (
                <button key={o.start} disabled={busy} onClick={() => move(o.start)} className="card w-full text-left hover:border-cyan/60">
                  <div className="font-semibold">
                    {fmtMin(o.start)} – {fmtMin(o.end)}
                  </div>
                  <div className="text-xs text-muted">{o.legs.map((l) => l.room).join(" → ")}</div>
                </button>
              ))
            )}
            <ErrorNote error={err} />
          </div>
        )}
      </div>
    </CustomerShell>
  );
}
