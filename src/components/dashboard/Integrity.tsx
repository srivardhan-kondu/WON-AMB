"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { ErrorNote, Spinner } from "@/components/ui";
import { PinDialog } from "@/components/PinDialog";

interface Status {
  lock: { at: number; problems: string[] } | null;
  problems: string[];
}

/**
 * §9 crash recovery: the ledger is rebuilt from the DB on every boot (and every /api/health probe) and
 * compared against the engine invariants. A violation pauses new bookings until someone looks here.
 */
export function Integrity() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [pinErr, setPinErr] = useState<string | null>(null);

  useEffect(() => {
    api<Status>("/api/admin/integrity").then(setS).catch((e: Error) => setErr(e.message));
  }, []);

  async function recheck() {
    setErr(null);
    try {
      setS(await api<Status>("/api/admin/integrity", { body: { action: "recheck" } }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function unlock(pin: string, reason: string) {
    try {
      setS(await api<Status>("/api/admin/integrity", { body: { action: "unlock", reason, managerPin: pin } }));
      setAsking(false);
    } catch (e) {
      setPinErr((e as Error).message);
    }
  }

  if (!s) return err ? <ErrorNote error={err} /> : <Spinner />;
  return (
    <div className="space-y-4">
      <div className={`card space-y-2 ${s.lock ? "border-red/60" : "border-lime/40"}`}>
        <div className="flex items-center justify-between">
          <div className="font-semibold">{s.lock ? "New bookings are PAUSED" : "Schedule integrity OK"}</div>
          <button className="btn btn-sm" onClick={recheck}>
            Re-check now
          </button>
        </div>
        <p className="text-sm text-muted">
          On every start-up the system rebuilds the next 14 days of room schedules from the database and checks that no room is over capacity, no booking repeats a room, no hour mixes Rotation-Hour and 20-min legs, and every confirmed booking has its rooms.
          {s.lock && ` Paused since ${new Date(s.lock.at).toLocaleString("en-IN")}. Online booking, walk-ins and reschedules show “paused” until this clears; check-in and payments for existing bookings still work.`}
        </p>
        {s.problems.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 font-mono text-xs text-red">
            {s.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          s.lock && <div className="text-sm text-lime">The problems are gone. Press “Re-check now” to reopen bookings.</div>
        )}
        {s.lock && s.problems.length > 0 && (
          <button className="btn btn-danger" onClick={() => { setPinErr(null); setAsking(true); }}>
            Reopen bookings anyway (owner)…
          </button>
        )}
        <ErrorNote error={err} />
      </div>
      {asking && <PinDialog title="Reopen sales with open problems: owner PIN" needReason onSubmit={unlock} onClose={() => setAsking(false)} error={pinErr} />}
    </div>
  );
}
