"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CustomerShell } from "@/components/Shell";
import { ErrorNote, Spinner, StatusChip } from "@/components/ui";
import { ApiError, api } from "@/lib/client";
import { fmtDay, fmtMin } from "@/lib/time";

interface Me {
  name: string;
  phoneMasked: string;
  memberships: { id: number; plan: string; valid_till: string; visits_left: number | null; used: number; active: boolean; recent: { code: string; day: string; start_min: number; product: string }[] }[];
  bookings: { code: string; day: string; start_min: number; party_size: number; status: string; product: string; token: string }[];
}

/** §9: OTP login for membership views. Booking lookup itself stays code + phone (no OTP). */
export default function MePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<"loading" | "login" | "ready">("loading");
  const [phone, setPhone] = useState("");
  const [otpSent, setOtpSent] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/me"));
      setState("ready");
    } catch (e) {
      if ((e as ApiError).status === 401) setState("login");
      else setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function signOut() {
    await api("/api/me", { method: "DELETE" });
    setMe(null);
    setOtpSent(null);
    setOtp("");
    setState("login");
  }

  if (state === "loading") return <CustomerShell>{err ? <ErrorNote error={err} /> : <Spinner />}</CustomerShell>;

  if (state === "login" || !me)
    return (
      <CustomerShell>
        <div className="card space-y-3">
          <h1 className="text-xl font-semibold">My WON</h1>
          <p className="text-sm text-muted">See your membership visits and upcoming bookings. We&apos;ll send a code to your WhatsApp.</p>
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
      </CustomerShell>
    );

  return (
    <CustomerShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Hi{me.name ? `, ${me.name}` : ""}</h1>
            <div className="text-sm text-muted">{me.phoneMasked}</div>
          </div>
          <button className="btn btn-sm" onClick={signOut}>
            Sign out
          </button>
        </div>

        <div className="space-y-3">
          <div className="label">Memberships</div>
          {me.memberships.length === 0 && <div className="card text-sm text-muted">No membership on this number. Ask at the desk about 6- and 12-month plans.</div>}
          {me.memberships.map((m) => (
            <div key={m.id} className={`card space-y-2 ${m.active ? "border-cyan/40" : "opacity-60"}`}>
              <div className="flex items-center justify-between">
                <div className="font-semibold">{m.plan}</div>
                <span className={`chip ${m.active ? "text-lime" : "text-muted"}`}>{m.active ? "active" : "ended"}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className={`text-2xl font-semibold tracking-tight ${m.visits_left != null && m.visits_left <= 2 ? "text-amber" : ""}`}>{m.visits_left ?? "∞"}</div>
                  <div className="text-xs text-muted">visits left</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold tracking-tight">{m.used}</div>
                  <div className="text-xs text-muted">used</div>
                </div>
                <div>
                  <div className="font-mono text-sm leading-8">{fmtDay(m.valid_till)}</div>
                  <div className="text-xs text-muted">valid till</div>
                </div>
              </div>
              {m.recent.length > 0 && (
                <ul className="border-t border-line pt-2 text-xs text-muted">
                  {m.recent.map((v) => (
                    <li key={v.code}>
                      {fmtDay(v.day)} {fmtMin(v.start_min)} · {v.product}
                    </li>
                  ))}
                </ul>
              )}
              {m.active && <p className="text-xs text-muted">Member visits are booked at the front desk; a visit is only used when you check in.</p>}
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="label">Upcoming bookings</div>
          {me.bookings.length === 0 && <div className="card text-sm text-muted">Nothing booked yet.</div>}
          {me.bookings.map((b) => (
            <Link key={b.code} href={`/b/${b.code}?t=${b.token}`} className="card flex items-center justify-between hover:border-cyan/50">
              <div>
                <div className="font-mono text-sm">{b.code}</div>
                <div className="text-sm">{b.product}</div>
                <div className="text-xs text-muted">
                  {fmtDay(b.day)} · {fmtMin(b.start_min)} · {b.party_size} guest(s)
                </div>
              </div>
              <StatusChip status={b.status} />
            </Link>
          ))}
        </div>
      </div>
    </CustomerShell>
  );
}
