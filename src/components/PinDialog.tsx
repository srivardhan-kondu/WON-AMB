"use client";

import { useState } from "react";

/** Masked manager-PIN entry for overrides; the manager types it on the desk device. */
export function PinDialog({ title, needReason, onSubmit, onClose, error }: { title: string; needReason?: boolean; onSubmit: (pin: string, reason: string) => void; onClose: () => void; error?: string | null }) {
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 backdrop-blur-[2px] p-4" onClick={onClose}>
      <form
        className="card w-full max-w-sm space-y-3"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(pin, reason);
        }}
      >
        <div className="font-semibold">{title}</div>
        {needReason && <input className="input" placeholder="Reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
        <input className="input font-mono tracking-[0.5em]" type="password" inputMode="numeric" autoComplete="off" placeholder="Manager PIN" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus={!needReason} />
        {error && <div className="text-sm text-red">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={pin.length < 4 || (needReason && reason.trim().length < 3)}>
            Approve
          </button>
        </div>
      </form>
    </div>
  );
}
