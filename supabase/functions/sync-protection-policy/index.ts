// sync-protection-policy - the automatic protection-policy channel
// (Automatic Security/Protection Updates phase, user-directed).
//
// How it stays honest:
//   * It PULLS from PROSM's own control plane. No client ever supplies a
//     policy, and nothing here can be triggered into accepting one.
//   * Every payload is authenticated and integrity-checked with an HMAC-SHA256
//     signature over the exact bytes received, using a server-only secret. An
//     unsigned, wrongly signed, replayed or malformed payload is rejected
//     before anything is staged.
//   * Postgres then validates the payload against a fixed whitelist and does
//     validate -> stage -> activate in ONE transaction, keeping the previous
//     known-good version for rollback.
//   * Any failure (network, signature, validation, activation) leaves the
//     currently active policy untouched and is recorded. Protection is never
//     switched off by a failed update, and a policy can never turn licensing
//     enforcement, authorization, auditing or RLS off - those are not
//     policy-controlled at all.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { serviceClient } from "../_shared/licenseGate.ts";

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  }

  const service = serviceClient();

  try {
    // Only PROSM's own control plane (or the scheduled job holding the same
    // integration key) may ask for a sync.
    const expectedKey = Deno.env.get("PROSM_MANAGEMENT_API_KEY");
    const providedKey = request.headers.get("x-prosm-api-key");
    if (!expectedKey || !providedKey || !timingSafeEqual(providedKey, expectedKey)) {
      return errorResponse("Unauthorized.", 401, "UNAUTHORIZED");
    }

    const policyUrl = Deno.env.get("PROSM_PROTECTION_POLICY_URL");
    const signingSecret = Deno.env.get("PROSM_PROTECTION_SIGNING_KEY");
    if (!policyUrl || !signingSecret) {
      await service.rpc("record_prosm_time_protection_check_failure", { p_reason: "PROTECTION_CHANNEL_NOT_CONFIGURED" });
      return errorResponse("Protection update channel is not configured.", 500, "PROTECTION_NOT_CONFIGURED");
    }

    let rawBody: string;
    let signature: string | null;
    try {
      const upstream = await fetch(policyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-prosm-api-key": expectedKey },
        body: JSON.stringify({ action: "protectionPolicy", product: "prosm-time" }),
      });
      rawBody = await upstream.text();
      signature = upstream.headers.get("x-prosm-signature");
      if (!upstream.ok) {
        throw new Error(`CONTROL_PLANE_HTTP_${upstream.status}`);
      }
    } catch (networkError: any) {
      // Network availability is never a prerequisite: the last known-good
      // policy simply stays active.
      const { data } = await service.rpc("record_prosm_time_protection_check_failure", {
        p_reason: networkError?.message ?? "CONTROL_PLANE_UNREACHABLE",
      });
      return successResponse({ updated: false, reason: "CONTROL_PLANE_UNAVAILABLE", activeVersion: data?.activeVersion ?? null });
    }

    // Integrity + authenticity over the exact bytes received.
    const expectedSignature = await hmacHex(signingSecret, rawBody);
    if (!signature || !timingSafeEqual(signature, expectedSignature)) {
      const { data } = await service.rpc("record_prosm_time_protection_check_failure", { p_reason: "INVALID_SIGNATURE" });
      return errorResponse("Protection payload signature is invalid.", 400, "INVALID_SIGNATURE");
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      await service.rpc("record_prosm_time_protection_check_failure", { p_reason: "MALFORMED_PAYLOAD" });
      return errorResponse("Protection payload is malformed.", 400, "MALFORMED_PAYLOAD");
    }

    const version = Number(parsed?.version);
    const policy = parsed?.policy;
    if (!Number.isInteger(version) || version <= 0 || typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      await service.rpc("record_prosm_time_protection_check_failure", { p_reason: "MALFORMED_PAYLOAD" });
      return errorResponse("Protection payload is malformed.", 400, "MALFORMED_PAYLOAD");
    }

    // validate -> stage -> activate, atomically, inside Postgres.
    const { data, error } = await service.rpc("apply_prosm_time_protection_policy", {
      p_version: version,
      p_payload: policy,
      p_checksum: expectedSignature,
    });

    if (error) {
      await service.rpc("record_prosm_time_protection_check_failure", { p_reason: error.message });
      return errorResponse(error.message, 400, "PROTECTION_UPDATE_FAILED");
    }

    if (!data?.success) {
      // Rejected: the previously active version is still in force.
      return successResponse({ updated: false, reason: data?.error ?? "REJECTED", activeVersion: data?.activeVersion ?? null });
    }

    // Post-activation self-check. If the activated policy cannot be read back
    // and enforced, roll straight back to the previous known-good version.
    const { data: state, error: stateError } = await service.rpc("get_prosm_time_protection_state", {});
    if (stateError || state?.activeVersion !== version) {
      const { data: rolled } = await service.rpc("rollback_prosm_time_protection_policy", {
        p_reason: "POST_ACTIVATION_VERIFICATION_FAILED",
      });
      return successResponse({ updated: false, rolledBack: true, activeVersion: rolled?.activeVersion ?? null });
    }

    return successResponse({ updated: true, activeVersion: version, previousVersion: data.previousVersion ?? null });
  } catch (error: any) {
    await service.rpc("record_prosm_time_protection_check_failure", { p_reason: error?.message ?? "UNKNOWN" }).catch?.(() => {});
    return errorResponse(error?.message ?? "Protection update service unavailable.", 500, "INTERNAL_ERROR");
  }
});
