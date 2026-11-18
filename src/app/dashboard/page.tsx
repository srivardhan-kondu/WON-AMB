"use client";

import { useState } from "react";
import { StaffShell } from "@/components/StaffShell";
import { Kpis } from "@/components/dashboard/Kpis";
import { DayConfigEditor } from "@/components/dashboard/DayConfig";
import { Yield } from "@/components/dashboard/Yield";
import { Integrity } from "@/components/dashboard/Integrity";
import { AuditFeed, Memberships, Outbox, ProductsEditor } from "@/components/dashboard/Admin";

const TABS = ["KPIs", "Day config", "Products & prices", "Yield & GST", "Memberships", "Audit", "Messages", "Integrity"] as const;

export default function DashboardPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("KPIs");
  return (
    <StaffShell min="manager">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button key={t} className={`tab ${tab === t ? "tab-active" : ""}`} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        {tab === "KPIs" && <Kpis />}
        {tab === "Day config" && <DayConfigEditor />}
        {tab === "Products & prices" && <ProductsEditor />}
        {tab === "Yield & GST" && <Yield />}
        {tab === "Memberships" && <Memberships />}
        {tab === "Audit" && <AuditFeed />}
        {tab === "Messages" && <Outbox />}
        {tab === "Integrity" && <Integrity />}
      </div>
    </StaffShell>
  );
}
