"use client";

import { useEffect, useState } from "react";
import { StaffShell } from "@/components/StaffShell";
import { ErrorNote, Field, Spinner } from "@/components/ui";
import { api } from "@/lib/client";

export default function AccountPage() {
  return (
    <StaffShell min="floor">
      <Account />
    </StaffShell>
  );
}

function Account() {
  const [status, setStatus] = useState<{ totpEnabled: boolean; hasPin: boolean; canHavePin: boolean } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [pin, setPin] = useState("");
  const [newPw, setNewPw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [v, setV] = useState(0);

  useEffect(() => {
    api<NonNullable<typeof status>>("/api/staff/security").then(setStatus);
  }, [v]);

  async function run(body: Record<string, unknown>, ok: string) {
    setErr(null);
    setMsg(null);
    try {
      const r = await api<{ secret?: string; qr?: string }>("/api/staff/security", { body });
      if (r.secret && r.qr) setSetup({ secret: r.secret, qr: r.qr });
      else {
        setSetup(null);
        setMsg(ok);
      }
      setCode("");
      setV((x) => x + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!status) return <Spinner />;
  return (
    <div className="max-w-xl space-y-4">
      {msg && <div className="text-sm text-lime">{msg}</div>}
      <ErrorNote error={err} />

      <div className="card space-y-3">
        <div className="font-semibold">Two-factor login {status.totpEnabled ? <span className="text-lime">· on</span> : <span className="text-amber">· off</span>}</div>
        {!status.totpEnabled && !setup && (
          <button className="btn btn-cyan" onClick={() => run({ action: "totp-setup" }, "")}>
            Set up authenticator app
          </button>
        )}
        {setup && (
          <div className="space-y-2">
            <p className="text-sm text-muted">Scan with Google Authenticator / Authy / 1Password, then enter the 6-digit code.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="Authenticator QR" className="w-44 rounded-lg bg-white p-2" />
            <div className="font-mono text-xs text-muted break-all">{setup.secret}</div>
          </div>
        )}
        {(setup || status.totpEnabled) && (
          <div className="flex gap-2">
            <input className="input w-40 font-mono tracking-[0.3em]" inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            {setup ? (
              <button className="btn btn-primary" disabled={code.length !== 6} onClick={() => run({ action: "totp-enable", code }, "Two-factor login is on")}>
                Turn on
              </button>
            ) : (
              <button className="btn btn-danger" disabled={code.length !== 6} onClick={() => run({ action: "totp-disable", code }, "Two-factor login turned off")}>
                Turn off
              </button>
            )}
          </div>
        )}
      </div>

      {status.canHavePin && (
        <div className="card space-y-3">
          <div className="font-semibold">Override PIN {status.hasPin ? "" : <span className="text-amber">· not set</span>}</div>
          <p className="text-sm text-muted">Typed at the desk to approve cancellations, comp tickets, reschedule overrides and short-notice parties.</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <input className="input" type="password" placeholder="Your password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <input className="input font-mono" type="password" inputMode="numeric" placeholder="New PIN (4–8 digits)" value={pin} onChange={(e) => setPin(e.target.value)} />
            <button className="btn btn-primary" disabled={!pw || pin.length < 4} onClick={() => run({ action: "set-pin", password: pw, pin }, "PIN updated")}>
              Save PIN
            </button>
          </div>
        </div>
      )}

      <div className="card space-y-3">
        <div className="font-semibold">Password</div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Current">
            <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="New (10+ chars)">
            <input className="input" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" disabled={!pw || newPw.length < 10} onClick={() => run({ action: "set-password", password: pw, newPassword: newPw }, "Password changed")}>
              Change
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
