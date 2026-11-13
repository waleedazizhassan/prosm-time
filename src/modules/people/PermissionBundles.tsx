import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BadgeCheck, Banknote, CalendarCheck, Crown, FileBarChart, MapPin, Megaphone, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import Input from "../../components/common/Input";
import { formatDateOnly } from "../../core/utils/formatDate";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import PermissionRepository from "../../core/repositories/PermissionRepository";
import OwnerAuthorityRepository, { type OwnerDelegation } from "../../core/repositories/OwnerAuthorityRepository";

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
  const { t, i18n } = useTranslation("people");
  const [pending, setPending] = useState<{ id: string; action: "grant" | "revoke" } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Owner 2026-11-12: the "grant permissions" page is gone - its date window and its history live here now
  const [delegations, setDelegations] = useState<OwnerDelegation[]>([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!canGrantOwner) return;
    void OwnerAuthorityRepository.list().then((all) => setDelegations(all.filter((d) => d.userId === userId))).catch(() => undefined);
  }, [canGrantOwner, userId, tick]);

  // not withdrawn and not ended (a scheduled one counts: it blocks a second grant)
  const activeDelegation = delegations.find((d) => !d.revokedAt && (!d.endsAt || new Date(d.endsAt).getTime() > Date.now())) ?? null;
  const day = (iso: string) => formatDateOnly(iso.slice(0, 10), i18n.language);
  const describeWindow = (d: OwnerDelegation) =>
    d.endsAt ? t("ownerAuthority.window", { from: day(d.startsAt), to: day(d.endsAt) }) : t("ownerAuthority.since", { date: day(d.startsAt) });
  const ownerState = (d: OwnerDelegation) => new Date(d.startsAt).getTime() > Date.now()
    ? t("ownerAuthority.scheduled")
    : d.scope === "partial" ? t("ownerAuthority.hasSome", { count: d.permissionKeys.length }) : t("ownerAuthority.hasAll");

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
      if (pending.action === "grant" && startDate && endDate && endDate < startDate) {
        setBusy(false);
        return setError(t("ownerAuthority.endBeforeStart"));
      }
      // whole days in local time: from the start of the first day to the end of the last day
      const startsAt = startDate ? new Date(`${startDate}T00:00:00`).toISOString() : null;
      const endsAt = endDate ? new Date(`${endDate}T23:59:59`).toISOString() : null;
      failure = pending.action === "grant"
        ? await OwnerAuthorityRepository.grant(userId, reason.trim(), { scope: "full", startsAt, endsAt })
        : await OwnerAuthorityRepository.revoke(userId, reason.trim());
    } else {
      const bundle = PERMISSION_BUNDLES.find((b) => b.id === pending.id)!;
      for (const key of keysOf(bundle)) {
        // never twice: grant only what is missing
        if (pending.action === "grant" && effective.includes(key)) continue;
        if (pending.action === "revoke" && !effective.includes(key)) continue;
        // owner 2026-11-13: taking back really takes back - one given on top of the role is cleared, one the
        // role (or chosen delegated authority) brings is withdrawn for this person
        const r = pending.action === "grant"
          ? await PermissionRepository.setOverride(userId, key, true, reason.trim())
          : overrides[key] === true
            ? await PermissionRepository.clearOverride(userId, key, reason.trim())
            : await PermissionRepository.setOverride(userId, key, false, reason.trim());
        if (!r.success) { failure = r.message; break; }
      }
      // and it is checked: anything still held after taking back comes with the owner's whole authority
      if (!failure && pending.action === "revoke") {
        const after = await PermissionRepository.getEffectivePermissions(userId);
        if (after.success && keysOf(bundle).some((k) => (after.data ?? []).includes(k))) failure = "BUNDLE STILL HELD";
      }
    }
    setBusy(false);
    if (failure === "BUNDLE STILL HELD") { onChanged(); return setError(t("bundles.stillHeld", { owner: t("bundles.owner.title") })); }
    if (failure) return setError(humanizeBackendError(failure, t) ?? t("detail.genericError"));
    setPending(null);
    setReason("");
    setTick((n) => n + 1);
    onChanged();
  };

  const ownerFull = Boolean(activeDelegation && activeDelegation.scope !== "partial" && new Date(activeDelegation.startsAt).getTime() <= Date.now());
  const button = (id: string, Icon: LucideIcon, granted: boolean, partial: string | null, disabled = false, note: string | null = null) => (
    <div key={id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2) var(--space-3)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)" }}>
      <Icon size={18} aria-hidden="true" color={granted ? "var(--status-success-text)" : "var(--brand-primary)"} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ display: "block", fontSize: "var(--font-sm)" }}>{t(`bundles.${id}.title`)}</strong>
        <small style={{ color: "var(--text-secondary)" }}>{note ?? (granted ? <><BadgeCheck size={12} aria-hidden="true" /> {t("bundles.granted")}</> : partial ?? t(`bundles.${id}.hint`))}</small>
      </span>
      <Button size="xs" variant={granted ? "ghost" : "primary"} disabled={disabled} onClick={() => { setReason(""); setError(""); setStartDate(""); setEndDate(""); setPending({ id, action: granted ? "revoke" : "grant" }); }}>
        {granted ? t("bundles.revoke") : t("bundles.grant")}
      </Button>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
      <HintText small>{t("bundles.hint")}</HintText>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))", gap: "var(--space-2)" }}>
        {canGrantOwner ? button("owner", Crown, Boolean(activeDelegation), null) : null}
        {PERMISSION_BUNDLES.map((b) => {
          const s = state(b);
          if (s.keys.length === 0) return null;
          // with the owner's whole authority every permission comes from it: it is withdrawn there, not here
          if (ownerFull) return button(b.id, b.icon, s.all, null, true, t("bundles.viaOwner"));
          return button(b.id, b.icon, s.all, s.held > 0 ? t("bundles.partial", { held: s.held, total: s.keys.length }) : null);
        })}
      </div>
      {canGrantOwner && delegations.length > 0 ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: "var(--font-sm)" }}>
            {t("ownerAuthority.historyTitle")}{activeDelegation ? ` · ${ownerState(activeDelegation)} · ${describeWindow(activeDelegation)}` : ""}
          </summary>
          <ul style={{ listStyle: "none", margin: "var(--space-2) 0 0", padding: 0, display: "grid", gap: "var(--space-2)", fontSize: "var(--font-sm)" }}>
            {delegations.map((d) => (
              <li key={d.id} style={{ paddingBottom: "var(--space-2)", borderBottom: "1px solid var(--border-light)" }}>
                {t("ownerAuthority.grantedLine", { date: day(d.grantedAt), reason: d.reason })}
                <div style={{ color: "var(--text-secondary)" }}>{ownerState(d)} · {describeWindow(d)}</div>
                {d.revokedAt ? (
                  <div style={{ color: "var(--text-secondary)" }}>{t("ownerAuthority.revokedLine", { date: day(d.revokedAt), reason: d.revokeReason ?? "" })}</div>
                ) : d.endsAt && new Date(d.endsAt).getTime() <= Date.now() ? (
                  <div style={{ color: "var(--text-secondary)" }}>{t("ownerAuthority.ended")}</div>
                ) : (
                  <div style={{ color: "var(--status-success-text)" }}>{t("ownerAuthority.stillActive")}</div>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <Modal isOpen={Boolean(pending)} onClose={() => setPending(null)} size="sm"
        title={pending ? `${pending.action === "grant" ? t("bundles.grant") : t("bundles.revoke")} - ${t(`bundles.${pending.id}.title`)}` : ""}
        footer={<Button fullWidth loading={busy} variant={pending?.action === "revoke" ? "danger" : "primary"} onClick={() => void run()}>{pending?.action === "grant" ? t("bundles.grant") : t("bundles.revoke")}</Button>}>
        <ErrorText>{error}</ErrorText>
        {pending ? <HintText small>{t(pending.action === "grant" ? "bundles.grantNote" : "bundles.revokeNote")}</HintText> : null}
        {pending?.id === "owner" && pending.action === "grant" ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))", gap: "var(--space-3)" }}>
              <Input label={t("ownerAuthority.startLabel")} name="delegationStart" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <Input label={t("ownerAuthority.endLabel")} name="delegationEnd" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <HintText small>{t("ownerAuthority.windowHint")}</HintText>
            <HintText small>{t("ownerAuthority.neverDelegated")}</HintText>
          </>
        ) : null}
        <Textarea label={t("detail.reasonLabel")} name="bundleReason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </Modal>
    </div>
  );
}
