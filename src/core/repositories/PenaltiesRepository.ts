import { requireSupabaseClient } from "../api/supabaseClient";

// HR suite feature 1 (2026-11-11): the penalties bylaw, violations and incentives. The server decides who
// sees and does what, keeps the versions, counts the occurrences and posts to payroll.

export type Level = "manager" | "hr" | "owner";
export type ActionKind = "warning" | "deduction" | "suspension" | "investigation" | "other";
export type ViolationSource = "attendance_late" | "attendance_early_leave" | "attendance_absent" | "geofence_exit" | "manual";
export type ViolationStatus = "pending_investigation" | "pending_response" | "pending_approval" | "approved" | "reduced" | "rejected" | "appealed" | "cancelled" | "lapsed";
export type ViolationAction = "investigate" | "respond" | "approve" | "reduce" | "reject" | "acknowledge" | "appeal" | "refused_ack" | "appeal_confirm" | "appeal_cancel" | "cancel";
export type AmountType = "amount" | "days" | "percent";

export interface PenaltyActionType {
  id: string;
  code: string;
  name: string | null;
  kind: ActionKind;
  unit: "days" | "hours" | "amount" | null;
  requiresInvestigation: boolean;
  requiresResponse: boolean;
  responseDays: number | null;
  reporterCannotApprove: boolean;
  levels: Level[];
  autoApprove: boolean;
  isBuiltin?: boolean;
  isActive?: boolean;
  value?: number | null;
}

export interface LadderStep {
  occurrence: number;
  actionTypeId: string;
  value: number | null;
}

export interface ViolationType {
  id: string;
  name: string | null;
  templateKey: string | null;
  source: ViolationSource;
  thresholdMinutes: number | null;
  lookbackDays: number;
  steps: LadderStep[];
  isActive: boolean;
}

export interface IncentiveRule {
  id: string;
  name: string | null;
  templateKey: string | null;
  source: "no_late_month" | "full_attendance_month";
  amountType: AmountType;
  value: number;
  isActive: boolean;
}

export interface PenaltySettings {
  capUnit: "days_per_month" | "percent_of_wage" | "both" | null;
  capDays: number | null;
  capPercent: number | null;
  maxDaysToImpose: number | null;
  appealWindowDays: number | null;
  incentiveLevels: Level[];
}

export interface Bylaw {
  settings: PenaltySettings;
  actionTypes: PenaltyActionType[];
  violationTypes: ViolationType[];
  incentiveRules: IncentiveRule[];
  liability: { at: string | null; by: string | null };
  hasPayroll: boolean;
  versions: { id: string; version: number; effectiveFrom: string; resetCounters: boolean; publishedAt: string; publishedBy: string | null }[];
  activeVersion: number | null;
}

export interface ViolationStep {
  type: string;
  level: number | null;
  at: string;
  by: string | null;
  note: string | null;
  attachment: string | null;
  data: Record<string, unknown> | null;
}

export interface Violation {
  id: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  violationName: string | null;
  templateKey: string | null;
  source: ViolationSource;
  occurredOn: string;
  occurrence: number;
  suggested: PenaltyActionType;
  finalAction: PenaltyActionType;
  amount: number | null;
  status: ViolationStatus;
  levels: Level[];
  currentLevel: number;
  note: string | null;
  evidencePath: string | null;
  responseDueAt: string | null;
  employeeResponse: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  acknowledgedAt: string | null;
  refusedAckAt: string | null;
  refusedAckWitness: string | null;
  appealText: string | null;
  appealedAt: string | null;
  appealUntil: string | null;
  version: number;
  versionFrom: string;
  reportedBy: string | null;
  posted: number;
  settlement: number | null;
  actions: ViolationAction[];
  steps?: ViolationStep[];
  reduceOptions?: PenaltyActionType[];
}

export interface Incentive {
  id: string;
  userId: string;
  name: string;
  reason: string;
  templateKey: string | null;
  ruleName: string | null;
  periodMonth: string | null;
  amountType: AmountType;
  value: number;
  amount: number | null;
  status: "pending_approval" | "approved" | "rejected" | "cancelled";
  levels: Level[];
  currentLevel: number;
  createdAt: string;
  createdBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  canAct: boolean;
  canCancel: boolean;
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

const PenaltiesRepository = {
  bylaw: () => rpc<Bylaw>("get_prosm_time_penalty_bylaw"),
  saveSettings: (data: Record<string, unknown>) => rpc<{ success: boolean }>("save_prosm_time_penalty_settings", { p_data: data }),
  saveActionType: (id: string | null, data: Record<string, unknown>) => rpc<{ id: string }>("save_prosm_time_penalty_action_type", { p_id: id, p_data: data }),
  saveViolationType: (id: string | null, data: Record<string, unknown>) => rpc<{ id: string }>("save_prosm_time_violation_type", { p_id: id, p_data: data }),
  saveIncentiveRule: (id: string | null, data: Record<string, unknown>) => rpc<{ id: string }>("save_prosm_time_incentive_rule", { p_id: id, p_data: data }),
  addTemplate: () => rpc<{ added: number }>("add_prosm_time_penalty_template"),
  publish: (effectiveFrom: string, resetCounters: boolean, announcement: { title: string; body: string } | null) =>
    rpc<{ id: string; version: number; announcementId: string | null }>("publish_prosm_time_penalty_bylaw", { p_effective_from: effectiveFrom, p_reset_counters: resetCounters, p_announcement: announcement }),
  manualTypes: () => rpc<{ active: boolean; version?: number; types: { id: string; name: string | null; templateKey: string | null }[] }>("list_prosm_time_manual_violations"),
  record: (userId: string, typeId: string, day: string, note: string, evidence: string | null, clientRef: string) =>
    rpc<{ id: string }>("record_prosm_time_violation", { p_user_id: userId, p_type_id: typeId, p_day: day, p_note: note, p_evidence: evidence, p_client_ref: clientRef }),
  list: (userId: string | null = null, status: string | null = null) => rpc<Violation[]>("list_prosm_time_violations", { p_user_id: userId, p_status: status, p_limit: 300 }),
  get: (id: string) => rpc<Violation>("get_prosm_time_violation", { p_id: id }),
  act: (id: string, action: ViolationAction, data: Record<string, unknown> = {}) => rpc<{ success: boolean; status: ViolationStatus }>("act_prosm_time_violation", { p_id: id, p_action: action, p_data: data }),
  incentives: (userId: string | null = null) => rpc<Incentive[]>("list_prosm_time_incentives", { p_user_id: userId }),
  grantIncentive: (userId: string, data: Record<string, unknown>) => rpc<{ id: string | null }>("grant_prosm_time_incentive", { p_user_id: userId, p_data: data }),
  actIncentive: (id: string, action: "approve" | "reject" | "cancel", note: string | null) => rpc<{ success: boolean }>("act_prosm_time_incentive", { p_id: id, p_action: action, p_note: note }),
};

export default PenaltiesRepository;
