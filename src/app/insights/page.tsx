"use client";

import { StaffShell } from "@/components/StaffShell";
import { Insights } from "@/components/insights/Insights";

export default function InsightsPage() {
  return (
    <StaffShell min="owner">
      <Insights />
    </StaffShell>
  );
}
