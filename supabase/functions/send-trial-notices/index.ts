// send-trial-notices - PROSM Time demo (owner 2026-09-29). Called hourly by pg_cron with a
// private secret (x-trial-secret, kept in the vault and in this function's secrets - never in
// the code). Claims the due trial notices (a week before the end, and when it ends), which also
// puts them in the owner's notifications, and emails each owner through PROSM Platform's relay.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { sendEmail } from "../_shared/emailService.ts";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function render(kind: string, org: string, license: string, expiresAt: string): { subject: string; html: string } {
  const date = new Date(expiresAt).toISOString().slice(0, 10);
  const contacts = `<p><a href="mailto:sales@prosm.net">sales@prosm.net</a> · <a href="mailto:info@prosm.net">info@prosm.net</a> · <a href="mailto:support@prosm.net">support@prosm.net</a></p>`;
  const o = escapeHtml(org), l = escapeHtml(license);
  if (kind === "ENDING") {
    return {
      subject: `تنتهي الفترة التجريبية لـ PROSM Time في ${date} | Your PROSM Time trial ends on ${date}`,
      html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif"><p>تنتهي الفترة التجريبية لمؤسسة <b>${o}</b> في ${date}. بياناتك محفوظة ولن تُحذف.</p><p>للاستمرار اشترِ كود تفعيل وأدخله في البرنامج، أو تواصل معنا لتجديد الترخيص (رقم الترخيص ${l}):</p>${contacts}</div><hr><div dir="ltr" style="font-family:Arial,sans-serif"><p>The PROSM Time trial of <b>${o}</b> ends on ${date}. Your data is kept and will not be deleted.</p><p>To continue, buy an activation code and enter it in the app, or contact us to renew the license (license ${l}):</p>${contacts}</div>`,
    };
  }
  return {
    subject: "انتهت الفترة التجريبية لـ PROSM Time | Your PROSM Time trial has ended",
    html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif"><p>انتهت الفترة التجريبية لمؤسسة <b>${o}</b>. البرنامج متوقف مؤقتًا وكل بياناتك محفوظة.</p><p>أدخل كود تفعيل بعد تسجيل الدخول، أو تواصل معنا وسيعود كل شيء كما كان (رقم الترخيص ${l}):</p>${contacts}</div><hr><div dir="ltr" style="font-family:Arial,sans-serif"><p>The PROSM Time trial of <b>${o}</b> has ended. The app is paused and all your data is kept.</p><p>Enter an activation code after signing in, or contact us and everything returns as it was (license ${l}):</p>${contacts}</div>`,
  };
}

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");

  const secret = Deno.env.get("TRIAL_NOTICES_SECRET");
  if (!secret || request.headers.get("x-trial-secret") !== secret) {
    return errorResponse("Not allowed.", 401, "UNAUTHORIZED");
  }

  try {
    const serviceClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await serviceClient.rpc("claim_prosm_time_trial_notices");
    if (error) return errorResponse(error.message, 500, "CLAIM_FAILED");
    let sent = 0;
    for (const n of (data ?? []) as any[]) {
      const { subject, html } = render(n.kind, n.organization_name, n.license_number, n.expires_at);
      const result = await sendEmail({ to: n.owner_email, subject, html, purpose: `time-trial-${String(n.kind).toLowerCase()}`, supabase: serviceClient, organizationId: n.organization_id });
      if (result.sent) sent += 1;
    }
    return successResponse({ claimed: (data ?? []).length, sent });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Trial notices unavailable.", 500, "INTERNAL_ERROR");
  }
});
