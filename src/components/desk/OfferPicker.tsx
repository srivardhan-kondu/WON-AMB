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
      {offers.map((o) => {
        const on = picked === o.start;
        return (
          <button
            key={o.start}
            onClick={() => onPick(o)}
            className={`rounded-xl border-2 p-4 text-left transition ${on ? "border-pink bg-pink/5" : "border-line bg-panel hover:border-gray-300"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`text-2xl font-bold ${on ? "text-pink" : ""}`}>{fmtMin(o.start)}</span>
              <span className="text-lg font-semibold">{rupees(o.pricePaise)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1 empty:hidden">
                            {o.flash && <span className="chip border-amber/20 bg-amber/10 text-amber">flash price</span>}
              {o.peak && <span className="chip border-line bg-panel-2 text-muted">peak</span>}
            </div>
            <div className="mt-1.5 text-sm text-muted">{[...new Set(o.legs.map((l) => l.room))].join(" → ")}</div>
          </button>
        );
      })}
    </div>
  );
}
