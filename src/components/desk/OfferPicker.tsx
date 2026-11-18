"use client";

import { fmtMin, rupees } from "@/lib/time";

export interface DeskOffer {
  start: number;
  end: number;
  peak: boolean;
  pricePaise: number;
  flash?: boolean;
  legs: { roomId: string; room: string; start: number; end: number }[];
}

export function OfferPicker({ offers, picked, onPick }: { offers: DeskOffer[]; picked: number | null; onPick: (o: DeskOffer) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {offers.map((o, i) => (
        <button
          key={o.start}
          onClick={() => onPick(o)}
          className={`rounded-xl border p-3 text-left transition ${picked === o.start ? "border-cyan bg-cyan/5" : "border-line hover:border-cyan/50"}`}
        >
          <div className="flex items-center justify-between">
            <span className="text-lg font-semibold">{fmtMin(o.start)}</span>
            <span className="font-mono text-sm text-cyan">{rupees(o.pricePaise)}</span>
          </div>
          <div className="mt-1 text-xs text-muted">
            {i === 0 && <span className="mr-1 text-pink">best ·</span>}
            {o.flash && <span className="mr-1 text-amber">flash ·</span>}
            {[...new Set(o.legs.map((l) => l.room))].join(" → ")}
          </div>
        </button>
      ))}
    </div>
  );
}
