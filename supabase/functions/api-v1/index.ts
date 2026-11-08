// api-v1 - PROSM Time's general integration API (owner 2026-11-08: "an independent API any
// system can integrate with"). Read-only, versioned, cursor-paginated, one envelope:
//   GET /api-v1/me                       the key: organisation, scopes, environment
//   GET /api-v1/employees?cursor&limit   employees:read (email only with employees:read_sensitive)
//   GET /api-v1/sites?cursor&limit       sites:read
//   GET /api-v1/attendance?since&until&cursor&limit   attendance:read (window up to 92 days)
//   GET /api-v1/leaves?since&until&cursor&limit       leaves:read (dates, window up to 366 days)
//   GET /api-v1/payroll-records?cycleId&cursor&limit  payroll:read (locked cycles only)
// Authorization: "Bearer <api key>" (verify_jwt=false in config.toml - the caller is another
// system, not a signed-in member). The organisation always comes from the key, never from the
// request. Every request is rate limited before the key is looked up and written to
// api_request_log (method, path, status, duration, correlation id - no payloads).
// The legacy export-* endpoints stay as they were (same key checks, now scope-aware).
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { clientIdentifier, enforceRateLimits, hashIdentifier } from "../_shared/rateLimit.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-request-id, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "x-request-id",
};
const DAY = 24 * 60 * 60 * 1000;

type Auth = { organizationId: string; keyId: string; environment?: string; scopes?: string[]; scopeDenied?: boolean } | null;

const RESOURCES: Record<string, string | null> = {
  me: null,
  employees: "employees:read",
  sites: "sites:read",
  attendance: "attendance:read",
  leaves: "leaves:read",
  "payroll-records": "payroll:read",
};

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function json(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "x-request-id": requestId } });
}

function limitOf(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 100;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) throw new ApiError(400, "INVALID_LIMIT", "'limit' must be a whole number from 1 to 500.");
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return null;
  if (!UUID.test(value)) throw new ApiError(400, "INVALID_REQUEST", `'${name}' is not a valid id.`);
  return value;
}

function encodeCursor(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeCursor<T>(url: URL): T | null {
  const raw = url.searchParams.get("cursor");
  if (!raw) return null;
  try {
    return JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) as T;
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "'cursor' is not a cursor returned by this API.");
  }
}

function windowOf(url: URL, maxDays: number, defaultDays: number): { since: Date; until: Date } {
  const until = url.searchParams.get("until") ? new Date(url.searchParams.get("until")!) : new Date();
  const since = url.searchParams.get("since") ? new Date(url.searchParams.get("since")!) : new Date(until.getTime() - defaultDays * DAY);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) throw new ApiError(400, "INVALID_REQUEST", "'since' and 'until' must be ISO dates.");
  if (until < since) throw new ApiError(400, "INVALID_REQUEST", "'until' must not be before 'since'.");
  if (until.getTime() - since.getTime() > maxDays * DAY) throw new ApiError(400, "WINDOW_TOO_LARGE", `The window may not exceed ${maxDays} days.`);
  return { since, until };
}

serve(async (request: Request) => {
  const started = Date.now();
  const requestId = (request.headers.get("x-request-id") ?? "").slice(0, 80) || crypto.randomUUID();
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("api-v1");
  const resource = (at >= 0 ? parts.slice(at + 1) : parts).join("/");
  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let auth: Auth = null;

  const finish = async (body: unknown, status: number) => {
    try {
      await service.rpc("log_prosm_time_api_request", {
        p_org: auth?.organizationId ?? null, p_key: auth?.keyId ?? null, p_method: request.method,
        p_path: "/" + resource, p_status: status, p_duration: Date.now() - started, p_correlation: requestId,
      });
    } catch (error) {
      console.error("[api-v1] request log failed", (error as Error).message);
    }
    return json(body, status, requestId);
  };
  const fail = (status: number, code: string, message: string) => finish({ error: { code, message }, requestId }, status);

  try {
    if (request.method !== "GET") return await fail(405, "METHOD_NOT_ALLOWED", "This API is read-only: use GET.");
    if (!(resource in RESOURCES)) return await fail(404, "NOT_FOUND", "Unknown resource. See /me, /employees, /sites, /attendance, /leaves, /payroll-records.");

    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return await fail(401, "UNAUTHORIZED", "Send the API key as 'Authorization: Bearer <key>'.");
    const rawKey = header.slice(7).trim();

    const limited = await enforceRateLimits(service, [
      { scope: "api_v1_ip", identifier: clientIdentifier(request), limit: 300, windowSeconds: 300, blockSeconds: 900 },
      { scope: "api_v1_key", identifier: await hashIdentifier(rawKey), limit: 300, windowSeconds: 300, blockSeconds: 900 },
    ]);
    if (limited) return await fail(429, "RATE_LIMITED", "Too many requests - slow down and retry later.");

    const required = RESOURCES[resource];
    const { data, error } = await service.rpc("authenticate_prosm_time_api_key_v1", { p_raw_key: rawKey, p_required_scope: required });
    if (error) throw error;
    auth = data as Auth;
    if (!auth) return await fail(401, "UNAUTHORIZED", "The API key is invalid, revoked, expired, or the organisation's access is not active.");
    if (auth.scopeDenied) return await fail(403, "INSUFFICIENT_SCOPE", `This key does not have the '${required}' scope.`);

    const org = auth.organizationId;
    const limit = limitOf(url);
    const page = async (fn: string, args: Record<string, unknown>, next: (last: any) => unknown) => {
      const { data: rows, error: rpcError } = await service.rpc(fn, { p_org: org, ...args, p_limit: limit });
      if (rpcError) throw rpcError;
      const list = (rows ?? []) as any[];
      const nextCursor = list.length === limit ? encodeCursor(next(list[list.length - 1])) : null;
      return finish({ data: list.map(({ cursor: _cursor, ...row }) => row), nextCursor, requestId }, 200);
    };

    switch (resource) {
      case "me":
        return await finish({ data: { organizationId: org, keyId: auth.keyId, environment: auth.environment, scopes: auth.scopes }, requestId }, 200);
      case "employees":
        return await page("api_v1_employees", { p_after: decodeCursor<string>(url), p_sensitive: auth.scopes?.includes("employees:read_sensitive") ?? false }, (last) => last.id);
      case "sites":
        return await page("api_v1_sites", { p_after: decodeCursor<string>(url) }, (last) => last.id);
      case "attendance": {
        const { since, until } = windowOf(url, 92, 30);
        const after = decodeCursor<[string, string]>(url);
        return await page("api_v1_attendance", { p_since: since.toISOString(), p_until: until.toISOString(), p_after_at: after?.[0] ?? null, p_after_id: after?.[1] ?? null },
          (last) => [last.clockInAt, last.id]);
      }
      case "leaves": {
        const { since, until } = windowOf(url, 366, 90);
        return await page("api_v1_leaves", { p_since: since.toISOString().slice(0, 10), p_until: until.toISOString().slice(0, 10), p_after: decodeCursor<string>(url) },
          (last) => last.id);
      }
      case "payroll-records":
        return await page("api_v1_payroll_records", { p_cycle_id: uuidParam(url, "cycleId"), p_after: decodeCursor<string>(url) }, (last) => last.cursor);
    }
    return await fail(404, "NOT_FOUND", "Unknown resource.");
  } catch (error) {
    if (error instanceof ApiError) return await fail(error.status, error.code, error.message);
    console.error("[api-v1] failed", (error as any)?.message);
    return await fail(500, "INTERNAL_ERROR", "The request could not be completed. Quote the request id when reporting it.");
  }
});
