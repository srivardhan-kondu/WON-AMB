import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { body, handle, json } from "@/lib/http";
import { checkIntegrity, forceUnlock, integrityLock, runIntegrityCheck } from "@/lib/integrity";
import { approveOverride } from "@/lib/override";

/** Ledger integrity status (§9): the lock (if any) plus a fresh rebuild-and-compare. */
export const GET = handle(async () => {
  await requireStaff("manager");
  return json({ lock: integrityLock(), problems: checkIntegrity() });
});

const A = z.discriminatedUnion("action", [
  z.object({ action: z.literal("recheck") }),
  z.object({ action: z.literal("unlock"), reason: z.string().trim().min(5).max(300), managerPin: z.string().optional() }),
]);

/** recheck: clears the lock if the ledger is now clean. unlock: owner PIN, reopen sales despite open problems. */
export const POST = handle(async (req: Request) => {
  const staff = await requireStaff("manager");
  const a = await body(req, A);
  if (a.action === "recheck") {
    const problems = runIntegrityCheck("manual", staff.email);
    return json({ lock: integrityLock(), problems });
  }
  const approver = approveOverride(req, staff, a.managerPin, "integrity_unlock", ["owner"]);
  forceUnlock(staff.email, `${a.reason} (approved by ${approver})`);
  return json({ lock: null, problems: checkIntegrity() });
});
