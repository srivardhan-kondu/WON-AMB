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

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ role: string }>("/api/staff/login", { body: { email, password, totp: needTotp ? totp : undefined } });
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
      <div className="mb-6">
        <Logo sub="Staff" />
      </div>
      <form className="card space-y-4" onSubmit={login}>
        <Field label="Email">
          <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {needTotp && (
          <Field label="Authenticator code">
            <input className="input font-mono tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={totp} onChange={(e) => setTotp(e.target.value)} />
          </Field>
        )}
        <ErrorNote error={err} />
        <button className="btn btn-primary w-full" disabled={busy || !email || !password || (needTotp && totp.length !== 6)}>
          Log in
        </button>
      </form>
    </main>
  );
}
