// PROSM Time - single source of truth for outbound email across every
// Edge Function (invitations today; notifications/reports later, all
// through the same sendEmail()). Mirrors PROSM Platform's own
// _shared/emailService.ts architecture (single sendEmail() entry
// point, retry logic, delivery audit trail) so the pattern is
// consistent across PROSM products, but this file is its own,
// independent copy - no import crosses from the PROSM Platform
// repository into this one, and the provider differs deliberately:
// Resend (not Zoho), matching what was actually provisioned for this
// standalone product.
//
// Sending is a soft dependency: a missing/invalid RESEND_API_KEY (not
// yet configured) must never block the invitation itself from being
// created - the caller (invite-user) always has the verification
// code/link as a fallback. Every attempt, sent or failed, is written
// to audit_logs (§ - this repo's own general-purpose audit table;
// no separate email_log table, unlike Platform, since audit_logs
// already covers "who/what/when/outcome" generically).

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "PROSM Time <noreply@prosm.net>";

async function sendViaResend({ to, subject, html }: { to: string; subject: string; html: string }) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    throw new Error("MISSING RESEND_API_KEY");
  }

  const from = Deno.env.get("RESEND_FROM_EMAIL") || DEFAULT_FROM;

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  const responseText = await response.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(responseText);
  } catch {
    json = { raw: responseText };
  }

  if (!response.ok) {
    throw new Error(`Resend API Error: ${JSON.stringify(json)}`);
  }

  return json;
}

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !message.includes("MISSING RESEND_API_KEY");
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
      context: { purpose: entry.purpose, subject: entry.subject, provider: "resend" },
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
      await sendViaResend({ to, subject, html });

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
