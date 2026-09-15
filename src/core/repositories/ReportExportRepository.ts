import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface ReportExport {
  id: string;
  reportType: string;
  periodStart: string | null;
  periodEnd: string | null;
  fileName: string;
  storagePath: string;
  exportedByName: string;
  createdAt: string;
}

const BUCKET = "report-exports";

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface ReportExportRow {
  id: string;
  report_type: string;
  period_start: string | null;
  period_end: string | null;
  file_name: string;
  storage_path: string;
  exported_by_name: string;
  created_at: string;
}

function mapRow(row: ReportExportRow): ReportExport {
  return {
    id: row.id,
    reportType: row.report_type,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    fileName: row.file_name,
    storagePath: row.storage_path,
    exportedByName: row.exported_by_name,
    createdAt: row.created_at,
  };
}

// PROSM Time - user-reported real gap (#4, 2026-09-15): every PDF
// export in this app used to be a pure client-side download, nothing
// ever saved server-side. Wired into savePdfDocument.ts (the ONE
// choke point every existing export already goes through) rather than
// duplicated per call site - archiving a PDF is now automatic and
// best-effort, never blocking the real download that already
// succeeded by the time this runs.
class ReportExportRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async persist(reportType: string, fileName: string, blob: Blob, periodStart?: string, periodEnd?: string): Promise<ServiceResult<{ exportId: string }>> {
    try {
      const path = `${crypto.randomUUID()}-${fileName}`.replace(/[^a-zA-Z0-9._-]/g, "_");
      const orgScopedPath = `${await this.currentOrganizationId()}/${path}`;

      const { error: uploadError } = await this.client.storage.from(BUCKET).upload(orgScopedPath, blob, {
        contentType: "application/pdf",
        cacheControl: "no-store",
      });
      if (uploadError) return createError(uploadError.message);

      const { data, error } = await this.client.rpc("record_prosm_time_report_export", {
        p_report_type: reportType,
        p_file_name: fileName,
        p_storage_path: orgScopedPath,
        p_period_start: periodStart ?? null,
        p_period_end: periodEnd ?? null,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to archive this report.");

      return createSuccess({ exportId: data.exportId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Report archive service unavailable.");
    }
  }

  async listRecent(): Promise<ServiceResult<ReportExport[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_report_exports", { p_limit: 50 });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Report archive service unavailable.");
    }
  }

  async download(storagePath: string): Promise<ServiceResult<Blob>> {
    try {
      const { data, error } = await this.client.storage.from(BUCKET).download(storagePath);
      if (error) return createError(error.message);
      return createSuccess(data);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Report archive service unavailable.");
    }
  }

  private async currentOrganizationId(): Promise<string> {
    const { data, error } = await this.client.rpc("current_prosm_time_organization_id");
    if (error || !data) throw new Error(error?.message ?? "Unable to resolve organization.");
    return data as string;
  }
}

export default new ReportExportRepository();
