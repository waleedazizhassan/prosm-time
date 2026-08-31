// PROSM Time - single source of truth for outbound email across every
// Edge Function (invitations today; notifications/reports later, all
// through the same sendEmail()). Provider is Zoho Mail via OAuth,
// matching PROSM Platform's own proven _shared/emailService.ts
// pattern exactly (same secret names, same OAuth refresh-token flow,
// same Zoho Mail API call shape) - noreply@prosm.net's domain is
// already verified/authorized for Zoho on prosm.net's DNS (that is
// what makes Platform's own noreply@prosm.net sends work today), so
// reusing this same provider needs no DNS change, unlike the earlier
// Resend attempt which hit an unverified-domain wall. This file is
// its own independent copy - no import crosses from the PROSM
// Platform repository into this one - and PROSM Time holds its own
// copies of the ZOHO_* secrets in its own Supabase project (isolation
// preserved even though the values point at the same Zoho mailbox).
//
// Sending is a soft dependency: missing/invalid Zoho OAuth config
// must never block the invitation itself from being created - the
// caller (invite-user) always has the verification code/link as a
// fallback. Every attempt, sent or failed, is written to audit_logs
// (this repo's own general-purpose audit table; no separate email_log
// table, unlike Platform).

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

async function getZohoAccessToken(): Promise<string> {
  const apiDomain = Deno.env.get("ZOHO_API_DOMAIN") ?? "https://accounts.zoho.com";

  const refreshToken = Deno.env.get("ZOHO_REFRESH_TOKEN");
  const clientId = Deno.env.get("ZOHO_CLIENT_ID");
  const clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET");

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("MISSING ZOHO OAUTH CONFIGURATION");
  }

  const response = await fetch(`${apiDomain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  const json = await response.json();

  if (!response.ok || !json.access_token) {
    console.error("[emailService] ZOHO TOKEN ERROR:", json);
    throw new Error(JSON.stringify(json));
  }

  return json.access_token;
}

async function sendViaZoho({ to, subject, html }: { to: string; subject: string; html: string }) {
  const accountId = Deno.env.get("ZOHO_ACCOUNT_ID");
  const from = Deno.env.get("ZOHO_MAIL_FROM");

  if (!accountId || !from) {
    throw new Error("MISSING ZOHO MAIL CONFIGURATION");
  }

  const accessToken = await getZohoAccessToken();

  const response = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fromAddress: from,
      toAddress: to,
      subject,
      content: html,
      mailFormat: "html",
    }),
  });

  const responseText = await response.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(responseText);
  } catch {
    json = { raw: responseText };
  }

  if (!response.ok) {
    throw new Error(`Zoho Mail API Error: ${JSON.stringify(json)}`);
  }

  return json;
}

function isRetryable(error: unknown): boolean {
  // Config errors (missing credentials) are the same on every retry -
  // only worth retrying failures that could plausibly be transient
  // (network blip, Zoho briefly unavailable).
  const message = error instanceof Error ? error.message : String(error);
  return !message.includes("MISSING ZOHO");
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
      context: { purpose: entry.purpose, subject: entry.subject, provider: "zoho" },
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
      await sendViaZoho({ to, subject, html });

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
