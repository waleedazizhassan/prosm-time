// PROSM Time - single source of truth for outbound email across every
// Edge Function (invitations today; notifications/reports later, all
// through the same sendEmail()).
//
// Cross-product shared-infrastructure boundary (§ - PROSM Platform's
// docs/architecture/CROSS_PRODUCT_SHARED_SERVICES.md): outbound email
// is genuinely reusable delivery infrastructure, not PROSM Time
// business logic, so PROSM Time never holds Zoho credentials at all -
// it relays through PROSM Platform's own prosm-management-integration
// contract (action: "sendEmail"), the exact same authenticated channel
// (PROSM_MANAGEMENT_API_URL/PROSM_MANAGEMENT_API_KEY - already
// provisioned and already proven working via activate-organization/
// refresh-license-status) already used for activation and license
// status. Platform remains the sole owner of the ZOHO_* secrets and
// the noreply@prosm.net sender identity; this file never receives or
// stores either. The email's content (subject/html/purpose) stays
// entirely PROSM Time's own - Platform only relays it.
//
// Sending is a soft dependency: a missing/misconfigured integration
// contract or a relay failure must never block the invitation itself
// from being created - the caller (invite-user) always has the
// verification code/link as a fallback. Every attempt, sent or
// failed, is written to audit_logs (this repo's own general-purpose
// audit table) in addition to Platform's own email_log (product_id-
// scoped there).

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

async function relayViaProsmManagement({ to, subject, html, purpose }: { to: string; subject: string; html: string; purpose: string }) {
  const apiUrl = Deno.env.get("PROSM_MANAGEMENT_API_URL");
  const apiKey = Deno.env.get("PROSM_MANAGEMENT_API_KEY");

  if (!apiUrl || !apiKey) {
    throw new Error("MISSING PROSM MANAGEMENT INTEGRATION CONFIGURATION");
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-prosm-api-key": apiKey },
    body: JSON.stringify({ action: "sendEmail", to, subject, html, purpose }),
  });

  const json = await response.json().catch(() => null);

  if (!response.ok || !json?.success) {
    throw new Error(json?.error?.message ?? `PROSM Management relay error (HTTP ${response.status})`);
  }

  if (!json.data?.sent) {
    throw new Error(json.data?.error ?? "PROSM Management could not send this email.");
  }

  return json.data;
}

function isRetryable(error: unknown): boolean {
  // Config errors (missing integration credentials) are the same on
  // every retry - only worth retrying failures that could plausibly
  // be transient (network blip, Platform briefly unavailable).
  const message = error instanceof Error ? error.message : String(error);
  return !message.includes("MISSING PROSM MANAGEMENT");
}

async function logEmailAttempt(
  supabase: SupabaseClient | null,
  entry: {
    purpose: string;
    recipientEmail: string;
    subject: string;
    status: "sent" | "failed";
    errorMessage?: string;
    organizationId?: string | null;
    userId?: string | null;
  }
) {
  if (!supabase) return;

  try {
    await supabase.from("audit_logs").insert({
      organization_id: entry.organizationId ?? null,
      subject_user_id: entry.userId ?? null,
      action: entry.status === "sent" ? "INVITATION_EMAIL_SENT" : "INVITATION_EMAIL_FAILED",
      entity_name: "user_invitations",
      description: entry.status === "sent" ? `Invitation email sent to ${entry.recipientEmail}.` : `Invitation email to ${entry.recipientEmail} failed: ${entry.errorMessage}`,
      context: { purpose: entry.purpose, subject: entry.subject, provider: "prosm-management-relay" },
    });
  } catch (logError) {
    // The send outcome itself is what the caller needs - a failure to
    // write the audit row must never mask or override that outcome.
    console.error("[emailService] EMAIL LOG WRITE FAILED:", logError);
  }
}

export async function sendEmail({
  to,
  subject,
  html,
  purpose,
  supabase,
  organizationId,
  userId,
}: {
  to: string;
  subject: string;
  html: string;
  purpose: string;
  supabase?: SupabaseClient;
  organizationId?: string | null;
  userId?: string | null;
}): Promise<{ sent: boolean; error?: string }> {
  const maxAttempts = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await relayViaProsmManagement({ to, subject, html, purpose });

      await logEmailAttempt(supabase ?? null, {
        purpose,
        recipientEmail: to,
        subject,
        status: "sent",
        organizationId,
        userId,
      });

      return { sent: true };
    } catch (error) {
      lastError = error;
      console.error(`[emailService] EMAIL SEND ATTEMPT ${attempt} FAILED:`, error);

      if (attempt >= maxAttempts || !isRetryable(error)) {
        break;
      }
    }
  }

  const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);

  await logEmailAttempt(supabase ?? null, {
    purpose,
    recipientEmail: to,
    subject,
    status: "failed",
    errorMessage,
    organizationId,
    userId,
  });

  return { sent: false, error: errorMessage };
}
