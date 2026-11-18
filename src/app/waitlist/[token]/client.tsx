"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CustomerShell } from "@/components/Shell";
import { ErrorNote, Spinner, StatusChip } from "@/components/ui";
import { api } from "@/lib/client";
import { fmtDay, fmtMin } from "@/lib/time";

interface Entry {
  state: string;
  day: string;
  hour: number;
  party: number;
  product: string;
  offerStart: number | null;
  offerExpires: number | null;
}

export default function WaitlistOffer() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [e, setE] = useState<Entry | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Entry>(`/api/waitlist/${token}`).then(setE).catch((x: Error) => setErr(x.message));
  }, [token]);

  async function accept() {
    setBusy(true);
    try {
      const r = await api<{ code: string; token: string }>(`/api/waitlist/${token}`, { method: "POST", body: {} });
      router.push(`/pay/${r.code}?t=${r.token}`);
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  }

  return (
    <CustomerShell>
      {!e ? (
        err ? <ErrorNote error={err} /> : <Spinner />
      ) : (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Waitlist · {e.product}</div>
            <StatusChip status={e.state} />
          </div>
          <div className="text-muted">
            {fmtDay(e.day)} around {fmtMin(e.hour * 60)} · {e.party} guests
          </div>
          {e.state === "offered" && e.offerStart != null ? (
            <>
              <div className="rounded-xl border border-cyan/40 bg-cyan/5 p-3">
                A slot opened at <b>{fmtMin(e.offerStart)}</b>. It&apos;s yours if you accept within 10 minutes.
              </div>
              <button className="btn btn-primary w-full" disabled={busy} onClick={accept}>
                Accept & pay
              </button>
            </>
          ) : e.state === "waiting" ? (
            <p className="text-sm">You&apos;re in the queue. We&apos;ll WhatsApp you the moment a seat frees up.</p>
          ) : (
            <p className="text-sm text-muted">This waitlist entry is {e.state}.</p>
          )}
          <ErrorNote error={err} />
        </div>
      )}
    </CustomerShell>
  );
}
