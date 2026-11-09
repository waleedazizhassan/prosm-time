// payroll-export-job (2026-11-09, spec 15.11): bulk payslips as a background job.
//   POST {action: "start", cycleId, userIds?}  - the caller's session: the job is created (scope,
//        one serial per payslip) and processed in the background; returns the job id at once.
//   POST {action: "download", jobId}           - the caller's session: the permission is checked
//        again, then a short-lived signed link to the ZIP in the private bucket is returned.
//   POST {action: "sweep"}                      - the service role (every 5 minutes): resumes jobs
//        that stopped, fails very old ones, deletes files past their retention.
//   POST {action: "continue", jobId}            - the service role: the next slice of a long job.
// Each payslip is built from the stored snapshot (the same layout as the emailed payslip) and kept
// as a part file; at the end the parts become one ZIP and are deleted. A failure leaves no partial
// file. File names carry serial numbers only - no names or amounts.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import { zipSync } from "npm:fflate@0.8.2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { bytes, fontsFor } from "../_shared/pdfFonts.ts";
import { buildPayslipPdf, payslipTexts, type PayslipData, type PayslipLogo } from "../_shared/payslipPdfCore.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const BUCKET = "payroll-exports";
const BATCH = 20;
const TIME_BUDGET_MS = 110_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const service = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const partsDir = (org: string, job: string) => `${org}/${job}/parts`;

function issued(zone: string) {
  const now = new Date();
  return {
    date: new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric" }).format(now),
    time: new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now),
  };
}

async function finish(jobId: string, path: string | null, error: string | null) {
  await service.rpc("prosm_time_payroll_export_finish", { p_job_id: jobId, p_storage_path: path, p_error: error });
}

async function removeParts(org: string, jobId: string) {
  const { data } = await service.storage.from(BUCKET).list(partsDir(org, jobId), { limit: 10000 });
  const names = (data ?? []).map((f) => `${partsDir(org, jobId)}/${f.name}`);
  for (let i = 0; i < names.length; i += 500) await service.storage.from(BUCKET).remove(names.slice(i, i + 500));
}

// Process from the job's current progress until done, or until the time budget - then hand the rest on.
async function process(jobId: string): Promise<void> {
  const started = Date.now();
  let org = "";
  try {
    let logo: PayslipLogo | null | undefined;
    for (;;) {
      const { data: head, error: headError } = await service.rpc("prosm_time_payroll_export_batch", { p_job_id: jobId, p_from: 0, p_count: 0 });
      if (headError) throw new Error(headError.message);
      if (!head) return; // done, failed or expired already
      org = head.job.organizationId;
      const from = Number(head.job.done);
      const total = Number(head.job.total);
      if (from >= total) break;
      if (Date.now() - started > TIME_BUDGET_MS) {
        // the rest in a fresh invocation
        await fetch(`${supabaseUrl}/functions/v1/payroll-export-job`, {
          method: "POST",
          headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "continue", jobId }),
        }).catch(() => undefined); // the sweep resumes it otherwise
        return;
      }
      const { data: batch, error } = await service.rpc("prosm_time_payroll_export_batch", { p_job_id: jobId, p_from: from, p_count: BATCH });
      if (error || !batch) throw new Error(error?.message ?? "batch unavailable");
      if (logo === undefined) {
        const raw = batch.organization?.logoUrl ? await bytes(batch.organization.logoUrl).catch(() => null) : null;
        logo = raw && raw[0] === 0x89 && raw[1] === 0x50 ? { bytes: raw, type: "png" } : raw && raw[0] === 0xff && raw[1] === 0xd8 ? { bytes: raw, type: "jpg" } : null;
      }
      const when = issued(typeof batch.timeZone === "string" && batch.timeZone ? batch.timeZone : "Africa/Cairo");
      const language = batch.settings?.reportLanguage === "en" || batch.settings?.reportLanguage === "ar" ? batch.settings.reportLanguage : "bilingual";
      for (const doc of batch.documents as any[]) {
        const data: PayslipData = {
          language,
          organizationName: batch.organization?.name ?? "",
          cycleTitle: batch.cycle.title,
          periodStart: batch.cycle.periodStart,
          periodEnd: batch.cycle.periodEnd,
          cycleVersion: Number(batch.job.cycleVersion),
          serial: doc.serial,
          issuedAt: when.date,
          issuedTime: when.time,
          siteName: doc.siteName ?? null,
          taxNotice: batch.settings?.taxNotice ?? null,
          footerNote: batch.settings?.footerNote ?? null,
          employee: doc.employee,
        };
        const pdf = await buildPayslipPdf({ PDFDocument, rgb, fontkit } as any, await fontsFor(payslipTexts(data)), logo, data);
        const { error: upError } = await service.storage.from(BUCKET)
          .upload(`${partsDir(org, jobId)}/${String(doc.serial).padStart(8, "0")}.pdf`, pdf, { contentType: "application/pdf", upsert: true });
        if (upError) throw new Error(upError.message);
      }
      await service.rpc("prosm_time_payroll_export_progress", { p_job_id: jobId, p_done: from + (batch.documents as any[]).length });
    }

    // all parts are in: one ZIP, then the parts go
    const { data: files, error: listError } = await service.storage.from(BUCKET).list(partsDir(org, jobId), { limit: 10000, sortBy: { column: "name", order: "asc" } });
    if (listError) throw new Error(listError.message);
    const entries: Record<string, Uint8Array> = {};
    for (const file of files ?? []) {
      const { data: blob, error: dlError } = await service.storage.from(BUCKET).download(`${partsDir(org, jobId)}/${file.name}`);
      if (dlError || !blob) throw new Error(dlError?.message ?? "part missing");
      entries[`payslip-${file.name}`] = new Uint8Array(await blob.arrayBuffer());
    }
    const zip = zipSync(entries, { level: 6 });
    const path = `${org}/${jobId}/payslips-${jobId.slice(0, 8)}.zip`;
    const { error: zipError } = await service.storage.from(BUCKET).upload(path, zip, { contentType: "application/zip", upsert: true });
    if (zipError) throw new Error(zipError.message);
    await removeParts(org, jobId);
    await finish(jobId, path, null);
  } catch (error: any) {
    console.error("[payroll-export-job] failed", jobId, error?.message);
    if (org) await removeParts(org, jobId).catch(() => undefined);
    await finish(jobId, null, error?.message ?? "export failed");
  }
}

const background = (task: Promise<unknown>) => (typeof EdgeRuntime !== "undefined" ? EdgeRuntime.waitUntil(task) : void task);

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  const authorization = request.headers.get("authorization") ?? "";
  const body = await request.json().catch(() => ({}));
  const isService = authorization === `Bearer ${serviceKey}`;

  try {
    if (body.action === "continue") {
      if (!isService || typeof body.jobId !== "string") return errorResponse("Not allowed.", 403, "FORBIDDEN");
      background(process(body.jobId));
      return successResponse({ continued: body.jobId });
    }
    if (body.action === "sweep") {
      // like sync-all-licenses: the key the caller presents must pass the service-role-only grant
      const presented = createClient(supabaseUrl, authorization.replace(/^Bearer\s+/i, ""), {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: authorization } },
      });
      const { data: sweep, error } = await presented.rpc("prosm_time_payroll_export_sweep");
      if (error || !sweep) return errorResponse("Not allowed.", 403, "FORBIDDEN");
      for (const id of sweep.stale ?? []) await finish(id, null, "The export took too long and was stopped. Start it again.");
      for (const item of sweep.expired ?? []) {
        if (item.path) await service.storage.from(BUCKET).remove([item.path]);
        await service.rpc("prosm_time_payroll_export_expired", { p_job_id: item.id });
      }
      for (const id of sweep.resume ?? []) background(process(id));
      return successResponse({ resumed: (sweep.resume ?? []).length, expired: (sweep.expired ?? []).length });
    }

    // the caller's own session for start and download
    if (!authorization.startsWith("Bearer ")) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
    const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorization } },
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return errorResponse("Invalid or expired session.", 401, "UNAUTHORIZED");

    if (body.action === "start") {
      if (typeof body.cycleId !== "string") return errorResponse("cycleId is required.", 400, "INVALID_REQUEST");
      const { data, error } = await caller.rpc("start_prosm_time_payroll_export_job", {
        p_cycle_id: body.cycleId, p_user_ids: Array.isArray(body.userIds) ? body.userIds : null,
      });
      if (error) return errorResponse(error.message, /AUTHORITY/.test(error.message) ? 403 : 422, "START_REFUSED");
      background(process(data.jobId));
      return successResponse({ jobId: data.jobId, total: data.total });
    }

    if (body.action === "download") {
      if (typeof body.jobId !== "string") return errorResponse("jobId is required.", 400, "INVALID_REQUEST");
      const { data, error } = await caller.rpc("authorize_prosm_time_payroll_export_download", { p_job_id: body.jobId });
      if (error) return errorResponse(error.message, /AUTHORITY/.test(error.message) ? 403 : 404, "DOWNLOAD_REFUSED");
      const { data: signed, error: signError } = await service.storage.from(BUCKET).createSignedUrl(data.path, 300, { download: `payslips-v${data.cycleVersion}.zip` });
      if (signError || !signed) throw new Error(signError?.message ?? "could not sign");
      return successResponse({ url: signed.signedUrl, expiresInSeconds: 300 });
    }

    return errorResponse("Unknown action.", 400, "INVALID_REQUEST");
  } catch (error: any) {
    console.error("[payroll-export-job]", error?.message);
    return errorResponse("The export service failed. Try again.", 500, "INTERNAL_ERROR");
  }
});
