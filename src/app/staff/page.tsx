"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorNote, Field, Logo } from "@/components/ui";
import { ApiError, api } from "@/lib/client";

export default function StaffLogin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function login(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Read the fields from the form itself: browser autofill can fill them without firing onChange.
    const f = new FormData(e.currentTarget);
    const em = String(f.get("email") ?? email).trim();
    const pw = String(f.get("password") ?? password);
    setEmail(em);
    setPassword(pw);
    if (!em || !pw) return setErr("Enter your email and password");
    if (needTotp && totp.trim().length !== 6) return setErr("Enter the 6-digit code from your authenticator app");
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ role: string }>("/api/staff/login", { body: { email: em, password: pw, totp: needTotp ? totp.trim() : undefined } });
      const next = new URLSearchParams(window.location.search).get("next");
      router.replace(next && next.startsWith("/") ? next : r.role === "floor" ? "/runsheet" : r.role === "owner" || r.role === "manager" ? "/dashboard" : "/desk");
    } catch (x) {
      if (x instanceof ApiError && x.data.needTotp) {
        if (needTotp) setErr(x.message);
        setNeedTotp(true);
      } else setErr((x as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4">
      <div className="mb-6 text-center">
        <div className="inline-block">
          <Logo sub="Staff console" />
        </div>
        <h1 className="mt-6 text-xl font-semibold">Sign in to your account</h1>
        <p className="mt-1 text-sm text-muted">Front desk, floor team and managers</p>
      </div>
      <form className="card space-y-4 p-6" onSubmit={login}>
        <Field label="Email">
          <input className="input" type="email" name="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input className="input" type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {needTotp && (
          <Field label="Authenticator code">
            <input className="input font-mono tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={totp} onChange={(e) => setTotp(e.target.value)} />
          </Field>
        )}
        <ErrorNote error={err} />
        <button className="btn btn-primary w-full py-2.5" disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
    </main>
  );
}
