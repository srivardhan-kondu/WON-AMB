"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/client";
import { fmtDay, todayIST } from "@/lib/time";
import { Icon, type IconName } from "./icons";
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

interface NavItem {
  href: string;
  tab?: string;
  label: string;
  description: string;
  icon: IconName;
}
interface NavGroup {
  group: string;
  min: keyof typeof RANK;
  items: NavItem[];
}

/** Front-desk screens: /desk?tab=… */
export const DESK_TABS = ["today", "walkin", "checkin", "party", "waitlist"] as const;
export type DeskTab = (typeof DESK_TABS)[number];
/** Management screens: /dashboard?tab=… */
export const DASH_TABS = ["overview", "day", "products", "yield", "memberships", "audit", "messages", "integrity"] as const;
export type DashTab = (typeof DASH_TABS)[number];

export const NAV: NavGroup[] = [
  {
    group: "Front desk",
    min: "desk",
    items: [
      { href: "/desk", tab: "today", label: "Today's bookings", description: "Every booking for the day, with status, waivers and payment", icon: "calendar" },
      { href: "/desk", tab: "walkin", label: "New booking", description: "Walk-ins and phone bookings — the best available slots, ranked for you", icon: "plus" },
      { href: "/desk", tab: "checkin", label: "Check-in", description: "Scan the QR or type the booking code; sign waivers at the desk", icon: "qr" },
      { href: "/desk", tab: "party", label: "Parties", description: "Birthday and corporate bookings with exclusive room blocks", icon: "gift" },
      { href: "/desk", tab: "waitlist", label: "Waitlist", description: "Guests waiting for a sold-out hour; offers go out automatically", icon: "clock" },
    ],
  },
  {
    group: "Operations",
    min: "floor",
    items: [{ href: "/runsheet", label: "Runsheet", description: "Live room-by-room schedule for the floor team", icon: "squares" }],
  },
  {
    group: "Management",
    min: "manager",
    items: [
      { href: "/dashboard", tab: "overview", label: "Overview", description: "Revenue, utilisation and guest KPIs, this week vs last", icon: "chart" },
      { href: "/dashboard", tab: "day", label: "Day setup", description: "Opening hours, peak flag, hold-back, cleaning and room blocks", icon: "sliders" },
      { href: "/dashboard", tab: "products", label: "Products & prices", description: "Catalogue, prices and scheduled price changes", icon: "tag" },
      { href: "/dashboard", tab: "yield", label: "Yield & GST", description: "Flash prices, member rules, refunds and the GST export", icon: "trending" },
      { href: "/dashboard", tab: "memberships", label: "Memberships", description: "Members, plans and visits left", icon: "users" },
      { href: "/dashboard", tab: "audit", label: "Audit log", description: "Every override, refund and change — who did it and when", icon: "list" },
      { href: "/dashboard", tab: "messages", label: "Messages", description: "WhatsApp outbox: confirmations, reminders and OTPs", icon: "chat" },
      { href: "/dashboard", tab: "integrity", label: "Integrity", description: "Schedule health check — sales pause if anything is wrong", icon: "shield" },
    ],
  },
];

const ACCOUNT: NavItem = { href: "/account", label: "Account", description: "Password, two-step login and your override PIN", icon: "user" };

function hrefOf(i: NavItem) {
  return i.tab ? `${i.href}?tab=${i.tab}` : i.href;
}

/** The nav item for the current URL (first tab of a page when no ?tab= is given). */
function useActiveItem(): NavItem | undefined {
  const path = usePathname();
  const tab = useSearchParams().get("tab");
  if (path.startsWith(ACCOUNT.href)) return ACCOUNT;
  const items = NAV.flatMap((g) => g.items).filter((i) => path.startsWith(i.href));
  return items.find((i) => i.tab === tab) ?? items[0];
}

const ROLE_LABEL: Record<Staff["role"], string> = { desk: "Front desk", floor: "Floor staff", manager: "Manager", owner: "Owner" };

export function StaffShell({ children, min }: { children: ReactNode; min: keyof typeof RANK; wide?: boolean }) {
  return (
    <Suspense fallback={<div className="p-8 text-muted"><Spinner /></div>}>
      <Shell min={min}>{children}</Shell>
    </Suspense>
  );
}

function Shell({ children, min }: { children: ReactNode; min: keyof typeof RANK }) {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();
  const path = usePathname();
  const active = useActiveItem();

  useEffect(() => {
    api<Staff>("/api/staff/me")
      .then(setStaff)
      .catch(() => router.replace(`/staff?next=${encodeURIComponent(path)}`));
  }, [router, path]);

  if (!staff) return <div className="flex min-h-screen items-center justify-center text-muted"><Spinner /></div>;

  const allowed = atLeast(staff, min) || min === "floor";

  return (
    <StaffCtx.Provider value={staff}>
      <div className="min-h-screen">
        {/* Sidebar */}
        <div className={`fixed inset-0 z-30 bg-gray-900/30 lg:hidden ${menuOpen ? "" : "hidden"}`} onClick={() => setMenuOpen(false)} />
        <aside
          className={`no-print fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-line bg-sidebar transition-transform lg:translate-x-0 ${menuOpen ? "translate-x-0" : "-translate-x-full"}`}
        >
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-5">
            <Link href={staff.role === "floor" ? "/runsheet" : "/desk"} className="flex items-baseline gap-2">
              <span className="text-xl font-black tracking-tight neon-text">WON</span>
              <span className="text-xs font-medium text-muted">Staff console</span>
            </Link>
            <button className="text-muted lg:hidden" onClick={() => setMenuOpen(false)} aria-label="Close menu">
              <Icon name="x" />
            </button>
          </div>
          <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5" onClick={(e) => (e.target as HTMLElement).closest("a") && setMenuOpen(false)}>
            {NAV.filter((g) => atLeast(staff, g.min)).map((g) => (
              <div key={g.group}>
                <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted/80">{g.group}</div>
                <div className="space-y-0.5">
                  {g.items.map((i) => (
                    <NavLink key={hrefOf(i)} item={i} active={active === i} />
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className="border-t border-line p-3">
            <NavLink item={ACCOUNT} active={active === ACCOUNT} />
            <div className="mt-2 flex items-center gap-3 rounded-lg px-3 py-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pink/10 text-sm font-semibold text-pink">
                {staff.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{staff.name}</div>
                <div className="truncate text-xs text-muted">{ROLE_LABEL[staff.role]}</div>
              </div>
              <button
                className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-foreground"
                title="Log out"
                aria-label="Log out"
                onClick={async () => {
                  await api("/api/staff/logout", { method: "POST" });
                  router.replace("/staff");
                }}
              >
                <Icon name="logout" />
              </button>
            </div>
          </div>
        </aside>

        {/* Main column */}
        <div className="flex min-h-screen flex-col lg:pl-64">
          <header className="no-print sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-panel/85 px-4 backdrop-blur lg:px-8">
            <button className="-ml-1 rounded-md p-1.5 text-muted hover:bg-panel-2 lg:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu">
              <Icon name="menu" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold">{active?.label ?? "WON"}</h1>
              <p className="hidden truncate text-xs text-muted sm:block">{active?.description}</p>
            </div>
            <div className="hidden text-right text-xs text-muted md:block">
              <div className="font-medium text-foreground">{fmtDay(todayIST())}</div>
              <div>Level 6, AMB Mall</div>
            </div>
            {atLeast(staff, "desk") && !(active?.tab === "walkin") && (
              <Link href="/desk?tab=walkin" className="btn btn-primary btn-sm">
                <Icon name="plus" className="h-4 w-4" /> New booking
              </Link>
            )}
          </header>
          <main className="flex-1 px-4 py-6 lg:px-8">
            {allowed ? (
              children
            ) : (
              <div className="card max-w-md">
                Your role ({ROLE_LABEL[staff.role]}) can&apos;t open this screen.{" "}
                <Link className="font-medium text-pink" href="/runsheet">
                  Go to the runsheet
                </Link>
              </div>
            )}
          </main>
        </div>
      </div>
    </StaffCtx.Provider>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={hrefOf(item)}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
        active ? "bg-pink/10 text-pink" : "text-gray-600 hover:bg-panel-2 hover:text-foreground"
      }`}
    >
      <Icon name={item.icon} className={`h-5 w-5 ${active ? "text-pink" : "text-gray-400"}`} />
      {item.label}
    </Link>
  );
}

/** Read the ?tab= of the current page, falling back to the first allowed value. */
export function useTab<T extends string>(tabs: readonly T[]): T {
  const t = useSearchParams().get("tab");
  return (tabs as readonly string[]).includes(t ?? "") ? (t as T) : tabs[0];
}
