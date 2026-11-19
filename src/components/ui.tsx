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
  hold: "border-amber/20 bg-amber/10 text-amber",
  confirmed: "border-cyan/20 bg-cyan/10 text-cyan",
  arrived: "border-lime/20 bg-lime/10 text-lime",
  done: "border-line bg-panel-2 text-muted",
  no_show: "border-red/20 bg-red/10 text-red",
  cancelled: "border-line bg-panel-2 text-muted line-through",
  expired: "border-line bg-panel-2 text-muted",
  waiting: "border-amber/20 bg-amber/10 text-amber",
  offered: "border-cyan/20 bg-cyan/10 text-cyan",
  accepted: "border-lime/20 bg-lime/10 text-lime",
  mock: "border-line bg-panel-2 text-muted",
  sent: "border-lime/20 bg-lime/10 text-lime",
  failed: "border-red/20 bg-red/10 text-red",
};

const STATUS_LABEL: Record<string, string> = { hold: "awaiting payment", arrived: "checked in", no_show: "no-show" };

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`chip ${STATUS_STYLE[status] ?? "border-line bg-panel-2 text-muted"}`}>
      <span className="mr-1.5 h-2 w-2 rounded-full bg-current" />
      {STATUS_LABEL[status] ?? status.replace("_", " ")}
    </span>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="rounded-lg border border-red/20 bg-red/5 px-4 py-3 text-base font-medium text-red">{error}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-sm text-muted">{hint}</span>}
    </label>
  );
}

export function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="inline-flex items-center rounded-xl border border-line bg-panel shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
      <button type="button" className="px-5 py-2.5 text-2xl font-semibold text-muted hover:text-foreground disabled:opacity-30" disabled={value <= min} onClick={() => onChange(value - 1)} aria-label="fewer">
        −
      </button>
      <span className="w-14 text-center text-2xl font-bold">{value}</span>
      <button type="button" className="px-5 py-2.5 text-2xl font-semibold text-muted hover:text-foreground disabled:opacity-30" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label="more">
        +
      </button>
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}
