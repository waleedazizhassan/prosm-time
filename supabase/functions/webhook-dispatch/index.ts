// webhook-dispatch (2026-11-09, integration API v1b): every minute pg_cron calls this with the
// service role key; it takes the due webhook deliveries (prosm_time_webhook_claim - service role
// only, which is also how the caller is checked), posts each one signed, and records the result
// (prosm_time_webhook_result decides retry, dead or delivered).
// Signature: X-PROSM-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>.
// The receiver recomputes it with its secret and rejects old timestamps (replay protection).
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { successResponse, errorResponse } from "../_shared/http.ts";

const TIME_BUDGET_MS = 50_000;
const TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();

async function sign(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deliver(item: any): Promise<{ status: number; error: string | null }> {
  const body = JSON.stringify(item.body);
  const timestamp = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(item.url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "PROSM-Time-Webhooks/1.0",
        "X-PROSM-Event": item.body.type,
        "X-PROSM-Delivery": item.id,
        "X-PROSM-Signature": `t=${timestamp},v1=${await sign(item.secret, timestamp, body)}`,
      },
      body,
    });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (error: any) {
    return { status: 0, error: error?.name === "AbortError" ? "timeout" : String(error?.message ?? error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

serve(async (request: Request) => {
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
  // like sync-all-licenses: the presented key must pass the service-role-only grants
  const client = createClient(Deno.env.get("SUPABASE_URL")!, authorization.slice(7), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authorization } },
  });
  const started = Date.now();
  let sent = 0;
  let failed = 0;
  while (Date.now() - started < TIME_BUDGET_MS) {
    const { data: batch, error } = await client.rpc("prosm_time_webhook_claim", { p_limit: 50 });
    if (error) return sent || failed ? successResponse({ sent, failed }) : errorResponse("Not allowed.", 403, "FORBIDDEN");
    const items = (batch ?? []) as any[];
    if (items.length === 0) break;
    const results = await Promise.all(items.map(async (item) => ({ item, result: await deliver(item) })));
    for (const { item, result } of results) {
      await client.rpc("prosm_time_webhook_result", { p_delivery_id: item.id, p_status: result.status, p_error: result.error });
      if (result.status >= 200 && result.status < 300) sent += 1;
      else failed += 1;
    }
  }
  return successResponse({ sent, failed });
});
