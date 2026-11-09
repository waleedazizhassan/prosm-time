// announcement-email (2026-11-09 Media Center): "publish with email". Run every minute by
// pg_cron with the service role key, only while emails are waiting. Takes the queued recipients
// (prosm_time_announcement_email_claim - service role only), sends each one the announcement in
// their language from Platform's relay (sender "PROSM Time Announcements"), and records the
// outcome; a failure is retried twice, ten and twenty minutes later. Files are not attached - the
// email says how many there are and that they open in the app, where only recipients can open them.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { successResponse, errorResponse } from "../_shared/http.ts";
import { sendEmail } from "../_shared/emailService.ts";
import { emailLanguage, emailT, isRtl } from "../_shared/emailI18n.ts";

const TIME_BUDGET_MS = 45_000;
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const safeUrl = (url: string) => (/^https?:\/\//i.test(url) ? escape(url) : "");

function render(item: any) {
  const language = emailLanguage(item.language);
  const T = (path: string, vars: Record<string, unknown> = {}) => emailT(language, `announcement.${path}`, vars);
  const rtl = isRtl(language);
  const paragraphs = String(item.body ?? "").split(/\n{2,}/).map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`).join("");
  const links = (item.links ?? []) as { title: string; url: string }[];
  const html = `<div dir="${rtl ? "rtl" : "ltr"}" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;color:#1b2640;line-height:1.8;text-align:${rtl ? "right" : "left"}">
  <p style="color:#5b6b86;font-size:13px">${escape(item.kind === "statement" ? T("statementFrom", { org: item.organization }) : T("from", { org: item.organization }))}</p>
  <h2 style="margin:0 0 12px;font-size:20px">${escape(item.title)}</h2>
  ${paragraphs}
  ${links.length ? `<p><strong>${escape(T("links"))}</strong><br>${links.map((l) => safeUrl(l.url) ? `<a href="${safeUrl(l.url)}">${escape(l.title || l.url)}</a>` : "").filter(Boolean).join("<br>")}</p>` : ""}
  ${item.files > 0 ? `<p style="color:#5b6b86;font-size:13px">${escape(T("files", { count: item.files }))}</p>` : ""}
  ${item.requiresAck ? `<p style="color:#9a3412;font-size:14px">${escape(T("confirm"))}</p>` : ""}
  <hr style="border:none;border-top:1px solid #e3e9f2">
  <p style="color:#5b6b86;font-size:13px">${escape(emailT(language, "common.footer", { org: item.organization }))}</p>
</div>`;
  return { subject: `${item.kind === "statement" ? T("statementSubject") : T("subject")}: ${item.title}`.slice(0, 180), html };
}

serve(async (request: Request) => {
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
  // like webhook-dispatch: the presented key must pass the service-role-only grants
  const client = createClient(Deno.env.get("SUPABASE_URL")!, authorization.slice(7), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authorization } },
  });
  const started = Date.now();
  let sent = 0;
  let failed = 0;
  while (Date.now() - started < TIME_BUDGET_MS) {
    const { data: batch, error } = await client.rpc("prosm_time_announcement_email_claim", { p_limit: 25 });
    if (error) return sent || failed ? successResponse({ sent, failed }) : errorResponse("Not allowed.", 403, "FORBIDDEN");
    const items = (batch ?? []) as any[];
    if (items.length === 0) break;
    for (const item of items) {
      let ok = false;
      let reason: string | null = null;
      try {
        const { subject, html } = render(item);
        const result = await sendEmail({ to: item.email, subject, html, purpose: "announcement", organizationId: null, userId: item.userId });
        ok = result.sent;
        reason = result.error ?? null;
      } catch (sendError) {
        reason = sendError instanceof Error ? sendError.message : "send failed";
      }
      await client.rpc("prosm_time_announcement_email_result", { p_announcement_id: item.announcementId, p_user_id: item.userId, p_sent: ok, p_error: reason });
      if (ok) sent += 1;
      else failed += 1;
    }
  }
  return successResponse({ sent, failed });
});
