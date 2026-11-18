"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/client";
import { Spinner } from "./ui";

export interface Staff {
  sub: number;
  email: string;
  name: string;
  role: "desk" | "floor" | "manager" | "owner";
}

const StaffCtx = createContext<Staff | null>(null);
export const useStaff = () => useContext(StaffCtx)!;

const RANK = { floor: 0, desk: 1, manager: 2, owner: 3 } as const;
export const atLeast = (s: Staff, r: keyof typeof RANK) => RANK[s.role] >= RANK[r];

const NAV = [
  { href: "/desk", label: "Front desk", min: "desk" as const },
  { href: "/runsheet", label: "Runsheet", min: "floor" as const },
  { href: "/dashboard", label: "Dashboard", min: "manager" as const },
];

export function StaffShell({ children, min, wide }: { children: ReactNode; min: keyof typeof RANK; wide?: boolean }) {
  const [staff, setStaff] = useState<Staff | null>(null);
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    api<Staff>("/api/staff/me")
      .then(setStaff)
      .catch(() => router.replace(`/staff?next=${encodeURIComponent(path)}`));
  }, [router, path]);

  if (!staff) return <div className="p-8 text-muted"><Spinner /></div>;
  if (!atLeast(staff, min) && !(min === "floor"))
    return <div className="p-8">Your role ({staff.role}) can&apos;t open this screen. <Link className="text-cyan" href="/runsheet">Go to runsheet</Link></div>;

  return (
    <StaffCtx.Provider value={staff}>
      <div className="flex min-h-screen flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 no-print">
          <div className="flex items-center gap-4">
            <Link href="/desk" className="text-xl font-black neon-text">WON</Link>
            <nav className="flex gap-1">
              {NAV.filter((n) => atLeast(staff, n.min)).map((n) => (
                <Link key={n.href} href={n.href} className={`tab ${path.startsWith(n.href) ? "tab-active" : ""}`}>
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted">
            <Link href="/account" className="hover:text-foreground">
              {staff.name} · <span className="uppercase">{staff.role}</span>
            </Link>
            <button
              className="btn btn-sm"
              onClick={async () => {
                await api("/api/staff/logout", { method: "POST" });
                router.replace("/staff");
              }}
            >
              Log out
            </button>
          </div>
        </header>
        <div className={`mx-auto w-full flex-1 px-4 py-5 ${wide ? "" : "max-w-6xl"}`}>{children}</div>
      </div>
    </StaffCtx.Provider>
  );
}
