"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { CustomerShell, PhoneGate } from "@/components/Shell";
import { ErrorNote, Spinner } from "@/components/ui";
import { useBooking } from "@/components/useBooking";
import { api } from "@/lib/client";
import { AGE_BANDS, WAIVER_TEXT } from "@/lib/waiver";

export default function WaiverPage() {
  const { code } = useParams<{ code: string }>();
  const { booking: b, error, needPhone, submitPhone, reload, token } = useBooking(code);
  const [rows, setRows] = useState<{ name: string; ageBand: (typeof AGE_BANDS)[number]; accept: boolean }[]>([{ name: "", ageBand: "18+", accept: false }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (needPhone) return <CustomerShell><PhoneGate onSubmit={submitPhone} error={error} /></CustomerShell>;
  if (!b) return <CustomerShell>{error ? <ErrorNote error={error} /> : <Spinner />}</CustomerShell>;
  const left = b.party - b.waivers.length;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/waivers/${b!.code}`, { body: { t: token, guests: rows } });
      setRows([{ name: "", ageBand: "18+", accept: false }]);
      await reload();
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
          <div className="text-sm text-muted">Booking {b.code}</div>
          <h1 className="text-xl font-semibold">Guest waivers</h1>
          <p className="text-sm text-muted">
            {b.waivers.length} of {b.party} signed. Each guest signs once — forward this link to your group.
          </p>
          {b.waivers.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {b.waivers.map((w, i) => (
                <li key={i} className="text-lime">
                  ✓ {w.name} <span className="text-muted">({w.ageBand})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {left > 0 ? (
          <div className="card space-y-4">
            {/* Names from the leader's guest list that haven't signed yet, as suggestions. */}
            <datalist id="won-guest-names">
              {b.guests
                .filter((g) => !b.waivers.some((w) => w.name.toLowerCase() === g.name.toLowerCase()))
                .map((g) => (
                  <option key={g.name} value={g.name} />
                ))}
            </datalist>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
              {WAIVER_TEXT.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
            {rows.map((r, i) => (
              <div key={i} className="space-y-2 rounded-xl border border-line p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <input className="input" list="won-guest-names" placeholder="Guest full name" value={r.name} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                  <select className="input" value={r.ageBand} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, ageBand: e.target.value as (typeof AGE_BANDS)[number] } : x)))}>
                    {AGE_BANDS.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={r.accept} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, accept: e.target.checked } : x)))} />
                  <span>I have read and accept the waiver above{r.ageBand.startsWith("Under") ? " as this guest's guardian" : ""}.</span>
                </label>
              </div>
            ))}
            {rows.length < left && (
              <button className="btn btn-sm" onClick={() => setRows([...rows, { name: "", ageBand: "18+", accept: false }])}>
                + Add another guest
              </button>
            )}
            <ErrorNote error={err} />
            <button className="btn btn-primary w-full" disabled={busy || rows.some((r) => r.name.trim().length < 2 || !r.accept)} onClick={submit}>
              Sign {rows.length} waiver{rows.length > 1 ? "s" : ""}
            </button>
          </div>
        ) : (
          <div className="card border-lime/40 text-center">
            <div className="text-lime">All {b.party} waivers signed ✓</div>
            <Link href={`/b/${b.code}?t=${token}`} className="btn mt-3">
              Back to booking
            </Link>
          </div>
        )}
      </div>
    </CustomerShell>
  );
}
