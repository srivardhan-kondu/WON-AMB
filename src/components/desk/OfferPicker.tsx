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
  if (!offers.length) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {offers.map((o, i) => {
        const on = picked === o.start;
        return (
          <button
            key={o.start}
            onClick={() => onPick(o)}
            className={`rounded-lg border p-3 text-left transition ${on ? "border-pink bg-pink/5 ring-2 ring-pink/15" : "border-line bg-panel hover:border-gray-300"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`text-lg font-semibold ${on ? "text-pink" : ""}`}>{fmtMin(o.start)}</span>
              <span className="text-sm font-medium">{rupees(o.pricePaise)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {i === 0 && <span className="chip border-pink/20 bg-pink/10 text-pink">best match</span>}
              {o.flash && <span className="chip border-amber/20 bg-amber/10 text-amber">flash price</span>}
              {o.peak && <span className="chip border-line bg-panel-2 text-muted">peak</span>}
            </div>
            <div className="mt-1.5 text-xs text-muted">{[...new Set(o.legs.map((l) => l.room))].join(" → ")}</div>
          </button>
        );
      })}
    </div>
  );
}
