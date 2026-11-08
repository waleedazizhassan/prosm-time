// send-payslip-email (owner 2026-11-08): a manager sends an employee's requested payslip by email
// in one click. Runs with the manager's own session:
//   1. claim_prosm_time_payslip_email - checks the manager's payroll scope, the published payslip
//      of a locked cycle, reserves the request (no double sending), allocates the export serial,
//      and returns exactly the stored payslip of the published version (never recalculated);
//   2. the PDF is built here, on the server, from that stored payslip;
//   3. the email goes through the shared, server-side sender (PROSM Platform relay, the official
//      noreply@ address, sender name "PROSM Time Payroll") to the employee's registered email;
//   4. complete_prosm_time_payslip_email records the real outcome (sent / failed with the error)
//      and the action log entry. A failure keeps the request, retryable.
// No file is stored and no link is created: the PDF exists only inside this request and the email.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { sendEmail } from "../_shared/emailService.ts";
import { emailLanguage, emailT, isRtl } from "../_shared/emailI18n.ts";
import { base64, bytes, fontsFor, prosmLogo } from "../_shared/pdfFonts.ts";
import { buildPayslipPdf, payslipTexts, type PayslipData } from "../_shared/payslipPdfCore.ts";

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const fileSafe = (text: string) => text.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").slice(0, 40);

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");

  const authorizationHeader = request.headers.get("authorization");
  if (!authorizationHeader) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authorizationHeader } },
  });
  const { data: { user } } = await callerClient.auth.getUser();
  if (!user) return errorResponse("Invalid or expired session.", 401, "UNAUTHORIZED");

  const { requestId } = await request.json().catch(() => ({}));
  if (!requestId || typeof requestId !== "string") return errorResponse("requestId is required.", 400, "INVALID_REQUEST");

  // 1. reserve: scope, published payslip, no double sending, serial
  const { data: claim, error: claimError } = await callerClient.rpc("claim_prosm_time_payslip_email", { p_request_id: requestId });
  if (claimError || !claim?.attemptId) {
    const message = claimError?.message ?? "Unable to send this payslip.";
    const status = /AUTHORITY/.test(message) ? 403 : /NOT FOUND/.test(message) ? 404 : /ALREADY SENT|BEING SENT/.test(message) ? 409 : 422;
    return errorResponse(message, status, "SEND_REFUSED");
  }

  const finish = async (sent: boolean, error?: string) => {
    const { error: completeError } = await callerClient.rpc("complete_prosm_time_payslip_email", {
      p_request_id: requestId, p_attempt_id: claim.attemptId, p_sent: sent, p_error: error ?? null,
    });
    if (completeError) console.error("[send-payslip-email] outcome not recorded", completeError.message);
  };

  try {
    // 2. the PDF, from the stored payslip
    const language = emailLanguage(claim.language);
    const reportLanguage = claim.settings?.reportLanguage === "en" || claim.settings?.reportLanguage === "ar" ? claim.settings.reportLanguage : "bilingual";
    const employee = claim.employee;
    const data: PayslipData = {
      language: reportLanguage,
      organizationName: claim.organization?.name ?? "",
      cycleTitle: claim.cycle.title,
      periodStart: claim.cycle.periodStart,
      periodEnd: claim.cycle.periodEnd,
      cycleVersion: Number(claim.cycle.cycleVersion),
      serial: claim.serial,
      issuedAt: new Date().toISOString().slice(0, 10),
      siteName: null,
      taxNotice: claim.settings?.taxNotice ?? null,
      footerNote: claim.settings?.footerNote ?? null,
      employee,
    };
    const fonts = await fontsFor(payslipTexts(data));
    const logo = claim.organization?.logoUrl ? await bytes(claim.organization.logoUrl).catch(() => null) : null;
    // the organisation's logo when it is a PNG; else PROSM's
    const png = logo && logo[0] === 0x89 && logo[1] === 0x50 ? logo : await prosmLogo();
    const pdf = await buildPayslipPdf({ PDFDocument, rgb, fontkit } as any, fonts, png, data);

    // 3. the email, server side, to the registered address
    const T = (path: string, vars: Record<string, unknown> = {}) => emailT(language, `payslip.${path}`, vars);
    const rtl = isRtl(language);
    const html = `<div dir="${rtl ? "rtl" : "ltr"}" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;color:#1b2640;line-height:1.8;text-align:${rtl ? "right" : "left"}">
  <p>${escape(T("greeting", { name: employee.full_name }))}</p>
  <p>${escape(T("intro", { cycle: claim.cycle.title, org: data.organizationName }))}</p>
  <p style="color:#5b6b86;font-size:13px">${escape(T("version", { version: data.cycleVersion, serial: data.serial }))}</p>
  <p style="color:#5b6b86;font-size:13px">${escape(T("private"))}</p>
  <hr style="border:none;border-top:1px solid #e3e9f2">
  <p style="color:#5b6b86;font-size:13px">${escape(emailT(language, "common.signature"))}</p>
</div>`;
    const service = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
    const result = await sendEmail({
      to: claim.to,
      subject: T("subject", { cycle: claim.cycle.title }),
      html,
      purpose: "payroll_payslip",
      supabase: service,
      organizationId: claim.organizationId,
      userId: claim.userId,
      attachments: [{ name: `Payslip-${fileSafe(claim.cycle.title)}-v${data.cycleVersion}-${data.serial}.pdf`, contentBase64: base64(pdf) }],
    });

    // 4. the real outcome
    await finish(result.sent, result.error);
    if (!result.sent) return errorResponse("The email could not be sent. The request stays open - try again.", 502, "EMAIL_FAILED");
    return successResponse({ status: "sent", serial: claim.serial, cycleVersion: data.cycleVersion });
  } catch (error: any) {
    await finish(false, error?.message ?? "PDF or email failed");
    return errorResponse("The payslip could not be prepared. The request stays open - try again.", 500, "SEND_FAILED");
  }
});
