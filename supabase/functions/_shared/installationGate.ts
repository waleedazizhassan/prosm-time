// PROSM Time - reusable server-side gate for the Anti-Crack &
// Unauthorized Installation spec's real enforcement step (the phase
// deliberately deferred by 20260909220000's own header comment).
//
// Reads the ALREADY-CACHED installation_identity.state via
// get_prosm_time_installation_status() (RLS'd to the caller's own
// org - safe to call with the same callerClient every protected Edge
// Function already builds) rather than a live Platform Management
// call on every protected request - both for latency and so a
// transient Platform Management outage can never look identical to
// "this installation is genuinely blocked."
//
// Fail-open policy (deliberate - this session's own hard-learned
// lesson from an earlier, unmerged branch's bug that gave zero grace
// to unregistered installations and would have locked out every real
// user instantly): only an explicit, already-recorded state of
// 'BLOCKED' denies the request. No record at all, 'ACTIVE', 'GRACE',
// a stale cache, or any read failure here all allow it - this gate
// can only ever get MORE permissive on ambiguity, never less. A
// missing or stale (>7 days) record triggers a non-blocking
// background sync via EdgeRuntime.waitUntil so the cache catches up
// without ever making the caller's real action wait on it.
// deno-lint-ignore-file no-explicit-any

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export interface InstallationGateResult {
  allowed: boolean;
  reason?: string;
}

export async function checkInstallationGate(callerClient: any, supabaseUrl: string, anonKey: string, authorizationHeader: string): Promise<InstallationGateResult> {
  try {
    const { data, error } = await callerClient.rpc("get_prosm_time_installation_status");
    if (error || !data) {
      return { allowed: true };
    }

    const lastSyncedAtMs = data.lastSyncedAt ? new Date(data.lastSyncedAt).getTime() : 0;
    const isStale = !data.registered || Date.now() - lastSyncedAtMs > STALE_MS;
    if (isStale) {
      triggerBackgroundSync(supabaseUrl, anonKey, authorizationHeader);
    }

    if (data.registered && data.state === "BLOCKED") {
      return {
        allowed: false,
        reason: data.message ?? "This installation is not covered by a valid license and access has been suspended. Please contact your administrator.",
      };
    }

    return { allowed: true };
  } catch (_err) {
    // Any failure reading the gate itself must fail OPEN, never closed.
    return { allowed: true };
  }
}

function triggerBackgroundSync(supabaseUrl: string, anonKey: string, authorizationHeader: string): void {
  const task = fetch(`${supabaseUrl}/functions/v1/sync-installation-identity`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: authorizationHeader },
    body: JSON.stringify({ platform: "web" }),
  }).catch(() => {
    // Best-effort only - a failed background sync just leaves the
    // cache stale until the next opportunity, never blocks anything.
  });

  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === "function") {
    runtime.waitUntil(task);
  }
}
