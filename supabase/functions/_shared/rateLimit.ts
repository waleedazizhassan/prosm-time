// PROSM Time - shared server-side rate limiting for the session-less
// Edge Functions (Security Hardening phase, user-directed). The real
// enforcement lives in Postgres (consume_prosm_time_rate_limit,
// § migration 20260909130000) - service_role-only, so a client can
// never consume, reset or bypass it. This module is only the caller.
// deno-lint-ignore-file no-explicit-any

import { errorResponse } from "./http.ts";

export interface RateLimitRule {
  scope: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
  blockSeconds?: number;
}

/**
 * Best-effort caller identity for rate limiting. Supabase Edge Functions
 * sit behind the platform proxy, so the client address arrives in
 * x-forwarded-for; the first hop is the closest thing to a real client IP.
 */
export function clientIdentifier(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

/**
 * Consumes every rule in order. Returns null when the request may
 * proceed, or a ready-to-return 429 Response when any rule is exhausted.
 * A limiter outage must never open the endpoint up, so a failed RPC call
 * is treated as "blocked".
 */
export async function enforceRateLimits(
  serviceClient: any,
  rules: RateLimitRule[]
): Promise<Response | null> {
  for (const rule of rules) {
    const { data, error } = await serviceClient.rpc("consume_prosm_time_rate_limit", {
      p_scope: rule.scope,
      p_identifier: rule.identifier,
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
      p_block_seconds: rule.blockSeconds ?? null,
    });

    if (error) {
      console.error("[rateLimit] limiter unavailable", rule.scope, error.message);
      return rateLimitedResponse(rule.blockSeconds ?? rule.windowSeconds);
    }
    if (!data?.allowed) {
      return rateLimitedResponse(Number(data?.retryAfterSeconds ?? rule.windowSeconds));
    }
  }
  return null;
}

function rateLimitedResponse(retryAfterSeconds: number): Response {
  const response = errorResponse(
    "Too many attempts. Please wait a few minutes and try again.",
    429,
    "RATE_LIMITED"
  );
  const headers = new Headers(response.headers);
  headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  return new Response(response.body, { status: 429, headers });
}

/**
 * Keeps a response from finishing measurably faster on one code path than
 * another (the classic timing side-channel on "does this email exist?").
 */
export async function padResponseTime(startedAtMs: number, minimumMs = 600): Promise<void> {
  const elapsed = Date.now() - startedAtMs;
  if (elapsed < minimumMs) {
    await new Promise((resolve) => setTimeout(resolve, minimumMs - elapsed));
  }
}

/**
 * SHA-256 hex of a value, so a secret (activation code, API key) is never
 * itself written into the rate-limit table as an identifier.
 */
export async function hashIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
