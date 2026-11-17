import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { getSupabaseClient } from "../../core/api/supabaseClient";
import { askToConfirm } from "../../core/auth/stepUp";

const KEY = "prosm.financeConfirmedAt";
const VALID_MS = 30 * 60 * 1000;

// Owner 2026-11-17 ("entering the module itself should ask for the code"): when the organisation asks for identity
// confirmation (or two-step verification) for sensitive work, entering the finance module asks once - then it holds
// for 30 minutes on this device. Each sensitive action still checks on the server.
export default function FinanceGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ok" | "refused">(() => {
    try { return Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < VALID_MS ? "ok" : "checking"; } catch { return "checking"; }
  });

  useEffect(() => {
    if (state !== "checking") return undefined;
    let alive = true;
    void (async () => {
      const { data } = await getSupabaseClient().rpc("get_prosm_time_step_up_policy");
      const policy = (data ?? {}) as { stepUpRequired?: boolean; mfaRequired?: boolean };
      if (!policy.stepUpRequired && !policy.mfaRequired) { if (alive) setState("ok"); return; }
      const confirmed = await askToConfirm(policy.mfaRequired ? "MFA_REQUIRED" : "STEP_UP_REQUIRED");
      if (!alive) return;
      if (confirmed) {
        try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* private mode: asked again next time */ }
      }
      setState(confirmed ? "ok" : "refused");
    })();
    return () => { alive = false; };
  }, [state]);

  if (state === "refused") return <Navigate to="/dashboard" replace />;
  if (state === "checking") return null;
  return <>{children}</>;
}
