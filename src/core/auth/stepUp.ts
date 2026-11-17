// Governance phase C (owner 2026-11-15, docs/governance/PROJECT_AWARE_GOVERNANCE_ASSESSMENT.md section 14.3).
// The server decides when a sensitive action needs a recent sign-in (STEP_UP_REQUIRED) or a verified second factor
// (MFA_REQUIRED). This helper only reacts to that answer: it records the refusal, asks the person to confirm who
// they are (StepUpHost shows the window), and tries the action once more. It never decides anything itself.
import { getSupabaseClient } from "../api/supabaseClient";

export type StepUpCode = "STEP_UP_REQUIRED" | "MFA_REQUIRED";
type Confirm = (code: StepUpCode) => Promise<boolean>;

let confirmer: Confirm | null = null;

/** StepUpHost registers the window that asks for the password or the authenticator code. */
export function registerStepUpConfirmer(next: Confirm | null) {
  confirmer = next;
}

export function stepUpCode(message: string | null | undefined): StepUpCode | null {
  if (!message) return null;
  if (message.includes("MFA_REQUIRED")) return "MFA_REQUIRED";
  if (message.includes("STEP_UP_REQUIRED")) return "STEP_UP_REQUIRED";
  return null;
}

/**
 * Runs a sensitive call; if the server asks to confirm the identity, asks the person and runs it once more.
 * `run` returns the call's error message (or null) together with whatever the caller needs.
 */
export async function withStepUp<T extends { error: string | null }>(action: string, run: () => Promise<T>): Promise<T> {
  const first = await run();
  const code = stepUpCode(first.error);
  if (!code) return first;
  try {
    await getSupabaseClient().rpc("record_prosm_time_step_up_denied", { p_action: action, p_code: code });
  } catch {
    // recording the refusal is best effort; the server already refused
  }
  if (!confirmer || !(await confirmer(code))) return first;
  return run();
}

/** Owner 2026-11-17: ask the person to confirm who they are now (entering the finance module), without a refused call first. */
export async function askToConfirm(code: StepUpCode): Promise<boolean> {
  return confirmer ? confirmer(code) : false;
}
