"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Logo } from "./ui";

export function CustomerShell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 pb-20 pt-6">
      <header className="mb-6 no-print">
        <Logo />
      </header>
      {children}
    </main>
  );
}

export function PhoneGate({ onSubmit, error }: { onSubmit: (phone: string) => void; error: string | null }) {
  const [phone, setPhone] = useState("");
  return (
    <div className="card space-y-3">
      <div className="font-semibold">Confirm it&apos;s you</div>
      <p className="text-sm text-muted">Enter the mobile number used for this booking.</p>
      <input className="input" inputMode="tel" placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
      {error && <div className="text-sm text-red">{error}</div>}
      <button className="btn btn-primary w-full" disabled={phone.replace(/\D/g, "").length < 10} onClick={() => onSubmit(phone)}>
        Continue
      </button>
    </div>
  );
}
