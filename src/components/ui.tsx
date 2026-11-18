"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function Logo({ sub }: { sub?: string }) {
  return (
    <Link href="/" className="flex items-baseline gap-2">
      <span className="text-2xl font-black tracking-tight neon-text">WON</span>
      <span className="text-xs uppercase tracking-[0.2em] text-muted">{sub ?? "World of Neon"}</span>
    </Link>
  );
}

const STATUS_STYLE: Record<string, string> = {
  hold: "border-amber/50 text-amber",
  confirmed: "border-cyan/50 text-cyan",
  arrived: "border-lime/50 text-lime",
  done: "border-line text-muted",
  no_show: "border-red/50 text-red",
  cancelled: "border-red/30 text-red/70",
  expired: "border-line text-muted",
  waiting: "border-amber/50 text-amber",
  offered: "border-cyan/50 text-cyan",
  accepted: "border-lime/50 text-lime",
};

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip ${STATUS_STYLE[status] ?? "border-line text-muted"}`}>{status.replace("_", "-")}</span>;
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="rounded-xl border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="inline-flex items-center rounded-xl border border-line bg-background">
      <button type="button" className="px-3 py-2 text-lg disabled:opacity-30" disabled={value <= min} onClick={() => onChange(value - 1)} aria-label="fewer">
        −
      </button>
      <span className="w-10 text-center font-mono text-lg">{value}</span>
      <button type="button" className="px-3 py-2 text-lg disabled:opacity-30" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label="more">
        +
      </button>
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}
