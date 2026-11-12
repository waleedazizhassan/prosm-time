import { requireSupabaseClient } from "../api/supabaseClient";

// HR suite feature 2 (2026-11-11): employee documents and their expiry dates. The server decides who may
// see and change what, keeps the states and sends the reminders.

export type DocumentStatus = "missing" | "pending_review" | "valid" | "expiring" | "expired" | "rejected" | "not_required";
export type ClockInRule = "none" | "warn" | "block";

export interface DocumentType {
  id: string;
  name: string;
  isMandatory: boolean;
  hasExpiry: boolean;
  reminderDays: number[];
  appliesTo: "all" | "job_titles" | "sites";
  jobTitleIds: string[];
  siteIds: string[];
  clockInRule: ClockInRule;
  templateKey: string | null;
  isActive: boolean;
}

export interface ArchivedDocument {
  id: string;
  documentNumber: string | null;
  expiryDate: string | null;
  filePath: string | null;
  status: DocumentStatus;
  uploadedAt: string | null;
}

export interface EmployeeDocument {
  id: string;
  typeId: string;
  typeName: string;
  isMandatory: boolean;
  hasExpiry: boolean;
  status: DocumentStatus;
  documentNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  daysLeft: number | null;
  hasFile: boolean;
  filePath: string | null;
  uploadedAt: string | null;
  rejectionReason: string | null;
  lastRemindedAt: string | null;
  pendingId: string | null;
  pending: { id: string; filePath: string | null; expiryDate: string | null; documentNumber: string | null; uploadedAt: string | null } | null;
  archived: ArchivedDocument[];
}

export interface DocumentsOverviewRow {
  id: string;
  userId: string;
  name: string;
  site: string | null;
  typeName: string;
  status: DocumentStatus;
  daysLeft: number | null;
  expiryDate?: string | null;
  lastRemindedAt?: string | null;
}

export interface DocumentsOverview {
  expired: number;
  expiring: number;
  missing: number;
  pendingReview: number;
  completePercent: number;
  action: DocumentsOverviewRow[];
  all: DocumentsOverviewRow[];
}

type Result<T> = { data: T | null; error: string | null };

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
  try {
    const { data, error } = await requireSupabaseClient().rpc(name, args);
    if (error) return { data: null, error: error.message };
    return { data: data as T, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : "Service unavailable." };
  }
}

const DocumentsRepository = {
  listTypes: () => rpc<DocumentType[]>("list_prosm_time_document_types"),
  saveType: (id: string | null, data: Record<string, unknown>) => rpc<{ id: string }>("save_prosm_time_document_type", { p_id: id, p_data: data }),
  addTemplates: (template: "eg" | "gulf") => rpc<{ added: number }>("add_prosm_time_document_templates", { p_template: template }),
  /** owner 2026-11-12: personnel add any document from a person's file by its name (reused or made) */
  ensureTypeFor: (userId: string, name: string, hasExpiry: boolean) =>
    rpc<{ id: string; name: string; hasExpiry: boolean }>("ensure_prosm_time_person_document_type", { p_user_id: userId, p_name: name, p_has_expiry: hasExpiry }),
  listFor: (userId: string) => rpc<EmployeeDocument[]>("list_prosm_time_employee_documents", { p_user_id: userId }),
  submit: (userId: string, typeId: string, data: { file_path: string; document_number?: string | null; issue_date?: string | null; expiry_date?: string | null; client_ref?: string | null }) =>
    rpc<{ id: string }>("submit_prosm_time_document", { p_user_id: userId, p_type_id: typeId, p_data: data }),
  review: (documentId: string, accept: boolean, reason: string | null) => rpc<{ success: boolean }>("review_prosm_time_document", { p_document_id: documentId, p_accept: accept, p_reason: reason }),
  remind: (documentId: string) => rpc<{ success: boolean }>("remind_prosm_time_document", { p_document_id: documentId }),
  overview: () => rpc<DocumentsOverview>("get_prosm_time_documents_overview"),
};

export default DocumentsRepository;
