"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CustomerShell, PhoneGate } from "@/components/Shell";
import { ErrorNote, Spinner } from "@/components/ui";
import { useBooking } from "@/components/useBooking";
import { api } from "@/lib/client";
import { fmtDay, fmtMin, rupees } from "@/lib/time";

interface HoldInfo {
  code: string;
  status: string;
  holdExpires: number | null;
  amountDuePaise: number;
  order: { provider: string; orderId: string; keyId: string | null } | null;
  token: string;
}

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void; on: (ev: string, cb: (r: unknown) => void) => void };
  }
}

export default function PayPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const { booking, error, needPhone, submitPhone, reload, token } = useBooking(code);
  const [hold, setHold] = useState<HoldInfo | null>(null);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const loadedScript = useRef(false);

  // Hold/order details come from the same holds payload, re-derived by booking status.
  useEffect(() => {
    if (!booking || !token) return;
    if (booking.status !== "hold") {
      router.replace(`/b/${booking.code}?t=${token}`);
      return;
    }
    api<HoldInfo>(`/api/bookings/${booking.code}/hold?t=${token}`).then(setHold).catch((e: Error) => setErr(e.message));
  }, [booking, token, router]);

  useEffect(() => {
    const tickNow = () => setNow(Date.now());
    const first = setTimeout(tickNow, 0);
    const i = setInterval(tickNow, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(i);
    };
  }, []);

  // Poll so the page flips to confirmed when the webhook lands.
  useEffect(() => {
    const i = setInterval(() => reload(), 3000);
    return () => clearInterval(i);
  }, [reload]);

  useEffect(() => {
    if (hold?.order?.provider !== "razorpay" || loadedScript.current) return;
    loadedScript.current = true;
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    document.body.appendChild(s);
  }, [hold]);

  if (needPhone) return <CustomerShell><PhoneGate onSubmit={submitPhone} error={error} /></CustomerShell>;
  if (!booking || !hold) return <CustomerShell>{error || err ? <ErrorNote error={error || err} /> : <Spinner />}</CustomerShell>;

  const left = now === 0 ? 600 : Math.max(0, Math.floor(((hold.holdExpires ?? 0) - now) / 1000));
  const expired = now !== 0 && left <= 0;

  async function payMock(outcome: "success" | "fail") {
    if (!hold?.order) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/api/payments/mock", { body: { orderId: hold.order.orderId, outcome } });
      await reload();
      if (outcome === "fail") setErr("Payment failed — your hold was released. Please start again.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function payRazorpay() {
    if (!hold?.order || !window.Razorpay || !booking) return;
    const rz = new window.Razorpay({
      key: hold.order.keyId,
      order_id: hold.order.orderId,
      amount: hold.amountDuePaise,
      currency: "INR",
      name: "World of Neon",
      description: `${booking.product.name} · ${booking.code}`,
      theme: { color: "#db2777" },
      handler: async (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        setBusy(true);
        try {
          await api(`/api/bookings/${booking.code}/confirm`, { body: { t: token, ...r } });
        } catch {
          /* webhook will still confirm */
        }
        await reload();
        setBusy(false);
      },
    });
    rz.on("payment.failed", () => setErr("Payment failed — try another UPI app or card."));
    rz.open();
  }

  return (
    <CustomerShell>
      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted">Booking {booking.code}</div>
          <div className={`font-mono text-sm ${left < 120 ? "text-red" : "text-amber"}`}>
            {expired ? "Hold expired" : `Held for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
          </div>
        </div>
        <div>
          <div className="text-xl font-semibold">{booking.product.name}</div>
          <div className="text-muted">
            {fmtDay(booking.day)} · {fmtMin(booking.start)} – {fmtMin(booking.end)} · {booking.party} guests
          </div>
        </div>
        <div className="flex items-baseline justify-between rounded-xl bg-panel-2 p-3">
          <span>{booking.depositPaise > 0 ? "Deposit due now (25%)" : "Total (incl. GST)"}</span>
          <span className="text-2xl font-semibold tracking-tight text-cyan">{rupees(hold.amountDuePaise)}</span>
        </div>
        <ErrorNote error={err} />
        {expired ? (
          <Link className="btn btn-primary w-full" href="/">
            Start again
          </Link>
        ) : hold.order?.provider === "razorpay" ? (
          <button className="btn btn-primary w-full py-3 text-base" disabled={busy} onClick={payRazorpay}>
            {busy ? <Spinner /> : null} Pay with UPI / card
          </button>
        ) : (
          <div className="space-y-2">
            <div className="rounded-lg border border-amber/20 bg-amber/5 px-3 py-2 text-xs text-amber">
              Test mode — no Razorpay keys configured. These buttons simulate the gateway webhook.
            </div>
            <button className="btn btn-primary w-full py-3 text-base" disabled={busy} onClick={() => payMock("success")}>
              {busy ? <Spinner /> : null} Pay {rupees(hold.amountDuePaise)} (simulate UPI success)
            </button>
            <button className="btn w-full" disabled={busy} onClick={() => payMock("fail")}>
              Simulate payment failure
            </button>
          </div>
        )}
        <p className="text-xs text-muted">Seats are reserved only while the timer runs. Your booking confirms the moment the payment lands.</p>
      </div>
    </CustomerShell>
  );
}
