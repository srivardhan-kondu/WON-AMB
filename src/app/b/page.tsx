"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CustomerShell } from "@/components/Shell";
import { ErrorNote } from "@/components/ui";
import { api } from "@/lib/client";

export default function FindBooking() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    const c = code.trim().toUpperCase().replace(/^(?!WON-)/, "WON-");
    try {
      const b = await api<{ token: string }>(`/api/bookings/${c}?phone=${encodeURIComponent(phone)}`);
      router.push(`/b/${c}?t=${b.token}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <CustomerShell>
      <div className="card space-y-3">
        <h1 className="text-xl font-semibold">Find my booking</h1>
        <input className="input font-mono uppercase" placeholder="WON-XXXX" value={code} onChange={(e) => setCode(e.target.value)} />
        <input className="input" placeholder="Mobile number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <ErrorNote error={err} />
        <button className="btn btn-primary w-full" disabled={code.length < 4 || phone.replace(/\D/g, "").length < 10} onClick={go}>
          Open booking
        </button>
      </div>
    </CustomerShell>
  );
}
