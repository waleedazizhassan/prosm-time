// A check made while the app opens (trial status, privacy acknowledgement)
// must never keep the app closed (owner 2026-10-18: "the app doesn't open
// offline"). With no connection it is skipped at once; on a weak one it
// gives up after STARTUP_CHECK_TIMEOUT_MS. The server still enforces every
// rule on each request.
export const STARTUP_CHECK_TIMEOUT_MS = 6000;

export async function startupCheck<T>(check: () => Promise<T>, timeoutMs = STARTUP_CHECK_TIMEOUT_MS): Promise<T | null> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
