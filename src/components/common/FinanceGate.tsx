import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { getSupabaseClient } from "../../core/api/supabaseClient";
import { askToConfirm } from "../../core/auth/stepUp";

const KEY = "prosm.financeConfirmed";
// Owner 2026-11-17: asked once for a working day - 8 hours - not every half hour. The check happens only when a
// finance page opens, so nothing being typed is ever interrupted or lost; the final irreversible steps (approve,
// reopen, publish payslips, export) still confirm on the server, and a refused step asks and retries itself.
const VALID_MS = 8 * 60 * 60 * 1000;

function confirmedFor(userId: string): boolean {
  try {
    const [who, at] = (sessionStorage.getItem(KEY) ?? "").split("|");
    return who === userId && Date.now() - Number(at) < VALID_MS;
  } catch {
    return false;
  }
}

// Owner 2026-11-17 ("entering the module itself should ask for the code"): when the organisation asks for identity
// confirmation (or two-step verification) for sensitive work, entering the finance module asks once. It is kept per
// person (another account on the same device is asked again) and ends with the browser tab / app session.
export default function FinanceGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ok" | "refused">("checking");

  useEffect(() => {
    if (state !== "checking") return undefined;
    let alive = true;
    void (async () => {
      const client = getSupabaseClient();
      const userId = (await client.auth.getSession()).data.session?.user.id ?? "";
      if (userId && confirmedFor(userId)) { if (alive) setState("ok"); return; }
      const { data } = await client.rpc("get_prosm_time_step_up_policy");
      const policy = (data ?? {}) as { stepUpRequired?: boolean; mfaRequired?: boolean };
      if (!policy.stepUpRequired && !policy.mfaRequired) { if (alive) setState("ok"); return; }
      const confirmed = await askToConfirm(policy.mfaRequired ? "MFA_REQUIRED" : "STEP_UP_REQUIRED");
      if (!alive) return;
      if (confirmed && userId) {
        try { sessionStorage.setItem(KEY, `${userId}|${Date.now()}`); } catch { /* private mode: asked again next time */ }
      }
      setState(confirmed ? "ok" : "refused");
    })();
    return () => { alive = false; };
  }, [state]);

  if (state === "refused") return <Navigate to="/dashboard" replace />;
  if (state === "checking") return null;
  return <>{children}</>;
}
