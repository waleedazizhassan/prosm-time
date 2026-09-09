// PROSM Time - the server-side license gate every protected operation
// passes through (License Enforcement & Installation Identity phase,
// user-directed).
//
// The decision is made ENTIRELY inside Postgres
// (enforce_prosm_time_license_gate, § migration 20260909140000): a
// service_role-only SECURITY DEFINER function that re-derives the caller's
// organization from their own server-side user row, applies the control
// plane's administrative override, then the license state, then the
// server-clock grace window. A modified client cannot change that decision -
// it can only choose not to show the warning it produces.
// deno-lint-ignore-file no-explicit-any

import { createClient } from "npm:@supabase/supabase-js@2";
import { errorResponse } from "./http.ts";

export interface LicenseGateDecision {
  allowed: boolean;
  state: string;
  identified: boolean;
  graceEndsAt: string | null;
  graceDaysRemaining: number | null;
  licenseStatus: string | null;
  protectionVersion: number | null;
}

/**
 * Installation credentials travel in dedicated headers so no existing
 * request body shape has to change.
 */
export function installationCredentials(request: Request): { key: string | null; secret: string | null } {
  return {
    key: request.headers.get("x-prosm-installation-key"),
    secret: request.headers.get("x-prosm-installation-secret"),
  };
}

export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export async function evaluateLicenseGate(
  request: Request,
  operation: string,
  authUserId: string
): Promise<LicenseGateDecision | { fatal: Response }> {
  const { key, secret } = installationCredentials(request);

  const { data, error } = await serviceClient().rpc("enforce_prosm_time_license_gate", {
    p_operation: operation,
    p_installation_key: key,
    p_installation_secret: secret,
    p_auth_user_id: authUserId,
  });

  if (error || !data) {
    // FAIL CLOSED. If the gate cannot render a decision, the operation does
    // not happen: an infrastructure error must never become a way to perform
    // protected work without a license check. The failure is logged and the
    // caller gets a retryable 503, not an authorization.
    console.error("[licenseGate] gate unavailable", operation, error?.message);
    return {
      fatal: errorResponse(
        "License verification is temporarily unavailable. Please try again.",
        503,
        "LICENSE_GATE_UNAVAILABLE"
      ),
    };
  }

  return {
    allowed: Boolean(data.allowed),
    state: String(data.state ?? "UNKNOWN"),
    identified: Boolean(data.identified),
    graceEndsAt: data.graceEndsAt ?? null,
    graceDaysRemaining: data.graceDaysRemaining ?? null,
    licenseStatus: data.licenseStatus ?? null,
    protectionVersion: data.protectionVersion ?? null,
  };
}

/**
 * Returns null when the operation may proceed, or a ready-to-return 403 when
 * the installation is unlicensed past its grace period, expired, suspended,
 * blocked or revoked.
 */
export async function enforceLicenseGate(
  request: Request,
  operation: string,
  authUserId: string
): Promise<Response | null> {
  const decision = await evaluateLicenseGate(request, operation, authUserId);
  if ("fatal" in decision) return decision.fatal;
  if (decision.allowed) return null;

  const response = errorResponse(
    licenseMessage(decision.state),
    403,
    `LICENSE_${decision.state}`
  );
  const headers = new Headers(response.headers);
  headers.set("x-prosm-license-state", decision.state);
  return new Response(response.body, { status: 403, headers });
}

function licenseMessage(state: string): string {
  switch (state) {
    case "SUSPENDED":
      return "This installation has been suspended. Please contact PROSM support.";
    case "BLOCKED":
      return "This installation has been blocked. Please contact PROSM support.";
    case "REVOKED":
      return "This license has been revoked. Please contact PROSM support.";
    case "EXPIRED":
      return "The license has expired. Please renew it to continue.";
    default:
      return "The license grace period has ended. Please activate a license to continue.";
  }
}
