import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface CameraEvidence {
  id: string;
  attendanceEventId: string;
  storagePath: string;
  contentType: string;
  capturedAt: string;
}

const BUCKET = "camera-evidence";

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface CameraEvidenceRow {
  id: string;
  attendance_event_id: string;
  storage_path: string;
  content_type: string;
  captured_at: string;
}

function mapRow(row: CameraEvidenceRow): CameraEvidence {
  return {
    id: row.id,
    attendanceEventId: row.attendance_event_id,
    storagePath: row.storage_path,
    contentType: row.content_type,
    capturedAt: row.captured_at,
  };
}

// PROSM Time WP-08/§16 - "Attendance Evidence (Camera)." Upload goes
// directly to the private bucket (authorized by storage.objects RLS,
// keyed on the attendance_event_id path segment - see the migration),
// then attach_prosm_time_camera_evidence() records the linkage/audit
// row. cacheControl is always 'no-store' - found via live verification
// that Supabase's smart CDN otherwise caches a GET response per exact
// bearer token, so a later permission revocation would not invalidate
// an already-cached read for that same token. Reads use the JS SDK's
// own authenticated download (respects the same RLS), never a raw
// public URL.
class EvidenceRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async uploadEvidence(attendanceEventId: string, file: File): Promise<ServiceResult<{ evidenceId: string }>> {
    try {
      const extension = file.name.includes(".") ? file.name.split(".").pop() : "jpg";
      const path = `attendance-events/${attendanceEventId}/${crypto.randomUUID()}.${extension}`;

      const { error: uploadError } = await this.client.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || "image/jpeg",
        cacheControl: "no-store",
      });
      if (uploadError) return createError(uploadError.message);

      const { data, error } = await this.client.rpc("attach_prosm_time_camera_evidence", {
        p_attendance_event_id: attendanceEventId,
        p_storage_path: path,
        p_content_type: file.type || "image/jpeg",
        p_file_size_bytes: file.size,
      });

      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to attach this evidence.");

      return createSuccess({ evidenceId: data.evidenceId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Evidence service unavailable.");
    }
  }

  async listEvidenceForEvent(attendanceEventId: string): Promise<ServiceResult<CameraEvidence[]>> {
    try {
      const { data, error } = await this.client.from("camera_evidence").select("*").eq("attendance_event_id", attendanceEventId).order("captured_at", { ascending: true });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Evidence service unavailable.");
    }
  }

  async getEvidenceObjectUrl(storagePath: string): Promise<ServiceResult<string>> {
    try {
      const { data, error } = await this.client.storage.from(BUCKET).download(storagePath);
      if (error) return createError(error.message);
      return createSuccess(URL.createObjectURL(data));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Evidence service unavailable.");
    }
  }
}

export default new EvidenceRepository();
