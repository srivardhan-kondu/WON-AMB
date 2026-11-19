"use client";

import { DASH_TABS, StaffShell, useTab } from "@/components/StaffShell";
import { Kpis } from "@/components/dashboard/Kpis";
import { DayConfigEditor } from "@/components/dashboard/DayConfig";
import { Yield } from "@/components/dashboard/Yield";
import { Integrity } from "@/components/dashboard/Integrity";
import { AuditFeed, Memberships, Outbox, ProductsEditor } from "@/components/dashboard/Admin";

export default function DashboardPage() {
  return (
    <StaffShell min="manager">
      <Dashboard />
    </StaffShell>
  );
}

function Dashboard() {
  const tab = useTab(DASH_TABS);
  return (
    <div className="space-y-4">
      {tab === "overview" && <Kpis />}
      {tab === "day" && <DayConfigEditor />}
      {tab === "products" && <ProductsEditor />}
      {tab === "yield" && <Yield />}
      {tab === "memberships" && <Memberships />}
      {tab === "audit" && <AuditFeed />}
      {tab === "messages" && <Outbox />}
      {tab === "integrity" && <Integrity />}
    </div>
  );
}
