"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { CustomerShell, PhoneGate } from "@/components/Shell";
import { ErrorNote, Spinner, StatusChip } from "@/components/ui";
import { GuestList } from "@/components/GuestList";
import { useBooking } from "@/components/useBooking";
import { fmtDay, fmtMin, rupees } from "@/lib/time";

export default function BookingPage() {
  const { code } = useParams<{ code: string }>();
  const { booking: b, error, needPhone, submitPhone, token, reload } = useBooking(code);

  if (needPhone) return <CustomerShell><PhoneGate onSubmit={submitPhone} error={error} /></CustomerShell>;
  if (!b) return <CustomerShell>{error ? <ErrorNote error={error} /> : <Spinner />}</CustomerShell>;

  const waiversLeft = b.party - b.waivers.length;
  const stops = mergeLegs(b.legs);

  return (
    <CustomerShell>
      <div className="space-y-4">
        <div className="card text-center">
          <div className="flex items-center justify-center gap-2">
            <span className="text-2xl font-semibold tracking-tight font-bold tracking-wider">{b.code}</span>
            <StatusChip status={b.status} />
          </div>
          {b.status === "confirmed" || b.status === "arrived" ? (
            <>
              {b.qr && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={b.qr} alt={`QR code for ${b.code}`} className="mx-auto mt-4 w-56 rounded-xl bg-white p-2" />
              )}
              <p className="mt-2 text-xs text-muted">Show this at the front desk · Level 6, AMB Mall</p>
            </>
          ) : b.status === "hold" ? (
            <Link href={`/pay/${b.code}?t=${token}`} className="btn btn-primary mt-4">
              Complete payment
            </Link>
          ) : (
            <p className="mt-3 text-sm text-muted">This booking is {b.status.replace("_", "-")}.</p>
          )}
        </div>

        <div className="card space-y-3">
          <div>
            <div className="text-lg font-semibold">{b.product.name}</div>
            <div className="text-muted">
              {fmtDay(b.day)} · {fmtMin(b.start)} – {fmtMin(b.end)} · {b.party} {b.party === 1 ? "guest" : "guests"}
            </div>
          </div>
          <ol className="space-y-1.5">
            {stops.map((l, i) => (
              <li key={i} className="flex items-center gap-3 text-sm">
                <span className="w-16 font-mono text-cyan">{fmtMin(l.start)}</span>
                <span>{l.room}</span>
              </li>
            ))}
          </ol>
          <div className="flex justify-between border-t border-line pt-3 text-sm">
            <span className="text-muted">Paid {b.depositPaise > 0 && b.paidPaise < b.pricePaise ? "(deposit)" : ""}</span>
            <span className="font-mono">
              {rupees(b.paidPaise)} {b.paidPaise < b.pricePaise ? <span className="text-muted">of {rupees(b.pricePaise)}</span> : null}
            </span>
          </div>
        </div>

        {["confirmed", "hold"].includes(b.status) && (
          <div className={`card ${waiversLeft > 0 ? "border-amber/50" : "border-lime/40"}`}>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">Waivers</div>
                <div className="text-sm text-muted">
                  {b.waivers.length} of {b.party} signed · no waiver, no game
                </div>
              </div>
              {waiversLeft > 0 ? (
                <Link className="btn btn-cyan" href={`/w/${b.code}?t=${token}`}>
                  Sign now
                </Link>
              ) : (
                <span className="text-lime">All set ✓</span>
              )}
            </div>
          </div>
        )}

        {["hold", "confirmed", "arrived"].includes(b.status) && (
          <GuestList code={b.code} token={token} party={b.party} guests={b.guests} editable={b.canEditGuests} onSaved={reload} />
        )}

        <div className="flex flex-wrap gap-2">
          {b.invoice && (
            <Link className="btn" href={`/invoice/${b.code}?t=${token}`}>
              Invoice {b.invoice}
            </Link>
          )}
          {b.canReschedule && (
            <Link className="btn" href={`/b/${b.code}/reschedule?t=${token}`}>
              Reschedule (1 free)
            </Link>
          )}
          <Link className="btn" href="/me">
            My memberships
          </Link>
          <a className="btn" href="https://maps.google.com/?q=AMB+Mall" target="_blank" rel="noreferrer">
            Directions
          </a>
        </div>
      </div>
    </CustomerShell>
  );
}

function mergeLegs(legs: { room: string; start: number; end: number }[]) {
  const out: { room: string; start: number; end: number }[] = [];
  for (const l of legs) {
    const prev = out[out.length - 1];
    if (prev && prev.start === l.start && prev.end === l.end) prev.room += ` + ${l.room}`;
    else out.push({ ...l });
  }
  return out;
}
