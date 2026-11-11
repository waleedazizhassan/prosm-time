import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BadgeCheck, Banknote, CalendarCheck, Crown, FileBarChart, MapPin, Megaphone, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import PermissionRepository from "../../core/repositories/PermissionRepository";
import OwnerAuthorityRepository from "../../core/repositories/OwnerAuthorityRepository";

// Owner 2026-11-12: "a button per role - the owner's authority, finance manager, HR manager, attendance only,
// sites... besides the single permissions. Nobody gets a permission twice: one taken with a whole role shows
// as granted in the single list on its own." A bundle grants only what the person does not hold yet; the
// single switches below read the same effective list, so they show it at once.
interface Bundle { id: string; icon: LucideIcon; keys: string[] }

export const PERMISSION_BUNDLES: Bundle[] = [
  { id: "finance", icon: Banknote, keys: ["payroll.access", "payroll.view", "payroll.view_cost", "payroll.edit_draft", "payroll.enter_monthly_variables", "payroll.review", "payroll.approve",
    "payroll.reopen", "payroll.publish_payslips", "payroll.export_payslips", "payroll.export_summary", "payroll.export_combined_allowances", "payroll.import", "payroll.manage_profiles",
    "payroll.manage_installments", "payroll.manage_settings", "payroll.view_audit_log", "allowances.view", "allowances.approve", "external_labor.view_pay", "external_labor.approve", "external_labor.export",
    "reports.view", "reports.export"] },
  { id: "hr", icon: Users, keys: ["hr.manage", "employees.view", "employees.create", "employees.edit", "leave.approve", "leave.manage_types", "leave.set_deduction", "departments.manage",
    "timesheets.approve", "announcements.publish", "reports.view"] },
  { id: "attendance", icon: CalendarCheck, keys: ["attendance.view", "attendance.correct", "attendance.manage_permissions", "attendance.clock_in_on_behalf", "attendance.clock_out_on_behalf",
    "attendance.review_integrity_flags", "exceptions.manage", "sessions.review_pending", "timesheets.generate", "timesheets.approve", "sos.acknowledge"] },
  { id: "sites", icon: MapPin, keys: ["sites.manage", "sites.manage_exit_policy", "sites.manage_integrity", "gps_settings.manage", "schedules.manage", "calendar.manage", "external_labor.view", "external_labor.manage"] },
  { id: "reports", icon: FileBarChart, keys: ["dashboard.view", "reports.view", "reports.generate_pdf", "reports.export", "audit.view"] },
  { id: "media", icon: Megaphone, keys: ["announcements.publish", "announcements.manage", "announcements.view_reads"] },
];

export default function PermissionBundles({ userId, effective, overrides, catalogKeys, canChange, canGrantOwner, onChanged }: {
  userId: string; effective: string[]; overrides: Record<string, boolean>; catalogKeys: string[]; canChange: (key: string) => boolean;
  canGrantOwner: boolean; onChanged: () => void;
}) {
  const { t } = useTranslation("people");
  const [pending, setPending] = useState<{ id: string; action: "grant" | "revoke" } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [isOwnerDelegate, setIsOwnerDelegate] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!canGrantOwner) return;
    void OwnerAuthorityRepository.list().then((all) => setIsOwnerDelegate(all.some((d) => d.userId === userId && !d.revokedAt))).catch(() => undefined);
  }, [canGrantOwner, userId, tick]);

  const keysOf = (b: Bundle) => b.keys.filter((k) => catalogKeys.includes(k) && canChange(k));
  const state = (b: Bundle) => {
    const keys = keysOf(b);
    const held = keys.filter((k) => effective.includes(k)).length;
    return { keys, held, all: keys.length > 0 && held === keys.length };
  };

  const run = async () => {
    if (!pending) return;
    if (!reason.trim()) return setError(t("detail.reasonRequired"));
    setBusy(true);
    setError("");
    let failure: string | null = null;
    if (pending.id === "owner") {
      failure = pending.action === "grant" ? await OwnerAuthorityRepository.grant(userId, reason.trim()) : await OwnerAuthorityRepository.revoke(userId, reason.trim());
    } else {
      const bundle = PERMISSION_BUNDLES.find((b) => b.id === pending.id)!;
      for (const key of keysOf(bundle)) {
        // never twice: grant only what is missing; take back only what was given on top of the role
        if (pending.action === "grant" && effective.includes(key)) continue;
        if (pending.action === "revoke" && overrides[key] !== true) continue;
        const r = pending.action === "grant"
          ? await PermissionRepository.setOverride(userId, key, true, reason.trim())
          : await PermissionRepository.clearOverride(userId, key, reason.trim());
        if (!r.success) { failure = r.message; break; }
      }
    }
    setBusy(false);
    if (failure) return setError(humanizeBackendError(failure, t) ?? t("detail.genericError"));
    setPending(null);
    setReason("");
    setTick((n) => n + 1);
    onChanged();
  };

  const button = (id: string, Icon: LucideIcon, granted: boolean, partial: string | null, disabled = false) => (
    <div key={id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2) var(--space-3)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)" }}>
      <Icon size={18} aria-hidden="true" color={granted ? "var(--status-success-text)" : "var(--brand-primary)"} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ display: "block", fontSize: "var(--font-sm)" }}>{t(`bundles.${id}.title`)}</strong>
        <small style={{ color: "var(--text-secondary)" }}>{granted ? <><BadgeCheck size={12} aria-hidden="true" /> {t("bundles.granted")}</> : partial ?? t(`bundles.${id}.hint`)}</small>
      </span>
      <Button size="xs" variant={granted ? "ghost" : "primary"} disabled={disabled} onClick={() => { setReason(""); setError(""); setPending({ id, action: granted ? "revoke" : "grant" }); }}>
        {granted ? t("bundles.revoke") : t("bundles.grant")}
      </Button>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
      <HintText small>{t("bundles.hint")}</HintText>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))", gap: "var(--space-2)" }}>
        {canGrantOwner ? button("owner", Crown, isOwnerDelegate, null) : null}
        {PERMISSION_BUNDLES.map((b) => {
          const s = state(b);
          if (s.keys.length === 0) return null;
          return button(b.id, b.icon, s.all, s.held > 0 ? t("bundles.partial", { held: s.held, total: s.keys.length }) : null);
        })}
      </div>
      <Modal isOpen={Boolean(pending)} onClose={() => setPending(null)} size="sm"
        title={pending ? `${pending.action === "grant" ? t("bundles.grant") : t("bundles.revoke")} - ${t(`bundles.${pending.id}.title`)}` : ""}
        footer={<Button fullWidth loading={busy} variant={pending?.action === "revoke" ? "danger" : "primary"} onClick={() => void run()}>{pending?.action === "grant" ? t("bundles.grant") : t("bundles.revoke")}</Button>}>
        <ErrorText>{error}</ErrorText>
        {pending ? <HintText small>{t(pending.action === "grant" ? "bundles.grantNote" : "bundles.revokeNote")}</HintText> : null}
        <Textarea label={t("detail.reasonLabel")} name="bundleReason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </Modal>
    </div>
  );
}
