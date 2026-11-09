// 2026-11-09 Media Center: announcement files live in PROSM Platform's external media service
// (private bucket, isolated by product and licence). Only this server talks to it, with the
// product key; a PROSM Time user never reaches Platform and gets no authority there.
// deno-lint-ignore-file no-explicit-any

export async function platformMedia(action: string, body: Record<string, unknown>): Promise<{ ok: boolean; data?: any; error?: string }> {
  const apiUrl = Deno.env.get("PROSM_MANAGEMENT_API_URL");
  const apiKey = Deno.env.get("PROSM_MANAGEMENT_API_KEY");
  if (!apiUrl || !apiKey) return { ok: false, error: "MEDIA SERVICE NOT CONFIGURED" };
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-prosm-api-key": apiKey },
      body: JSON.stringify({ action, ...body }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.success) return { ok: false, error: json?.error?.message ?? `MEDIA SERVICE ERROR (HTTP ${response.status})` };
    return { ok: true, data: json.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "MEDIA SERVICE UNAVAILABLE" };
  }
}
