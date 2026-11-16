// Owner 2026-11-15 (governance phase D): one person's permissions, grouped by area and folded, one switch per
// line, related permissions merged into one line (the server keeps each permission - a merged line grants or takes
// all of them together), a mark on what differs from the role, and one button back to the role's defaults.
// The server still decides every change (the governance rules of 20261113220000 apply to each permission).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import PermissionRepository, { type Permission } from "../../core/repositories/PermissionRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import Input from "../../components/common/Input";
import Modal from "../../components/common/Modal";
import Toggle from "../../components/common/Toggle";
import HrMoveNotice from "./HrMoveNotice";

// related permissions shown and changed as one line
const MERGED: { id: string; keys: string[] }[] = [
  { id: "onBehalf", keys: ["attendance.clock_in_on_behalf", "attendance.clock_out_on_behalf"] },
  { id: "payrollExports", keys: ["payroll.export_summary", "payroll.export_payslips", "payroll.export_combined_allowances"] },
  { id: "reports", keys: ["reports.view", "reports.generate_pdf"] },
  { id: "timesheets", keys: ["timesheets.generate", "timesheets.approve"] },
  { id: "announcements", keys: ["announcements.publish", "announcements.view_reads"] },
  { id: "externalPay", keys: ["external_labor.view_pay", "external_labor.export"] },
];

// areas, in this order; a permission goes to the first area whose prefix matches
const GROUPS: { id: string; prefixes: string[] }[] = [
  { id: "attendance", prefixes: ["attendance.", "exceptions.", "sessions.", "sos.", "timesheets.", "gps_settings."] },
  { id: "leave", prefixes: ["leave.", "calendar."] },
  { id: "people", prefixes: ["employees.", "people.", "departments.", "hr.", "administrators.", "permissions."] },
  { id: "payroll", prefixes: ["payroll.", "allowances."] },
  { id: "external", prefixes: ["external_labor."] },
  { id: "sites", prefixes: ["sites.", "schedules.", "projects."] },
  { id: "reports", prefixes: ["reports.", "dashboard.", "audit."] },
  { id: "settings", prefixes: ["announcements.", "notifications.", "settings."] },
];

interface Line {
  id: string;
  keys: string[];
  label: string;
}

interface Props {
  userId: string;
  catalog: Permission[];
  effective: string[];
  overrides: Record<string, boolean>;
  canChange: (key: string) => boolean;
  onChanged: () => void;
}

export default function PermissionMatrix({ userId, catalog, effective, overrides, canChange, onChanged }: Props) {
  const { t } = useTranslation("people");
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<{ kind: "line"; line: Line; on: boolean } | { kind: "reset" } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => {
    const known = new Set(catalog.map((p) => p.permissionKey));
    const name = (key: string) => {
      const p = catalog.find((x) => x.permissionKey === key);
      return t(`catalog.${key}`, { defaultValue: p?.name ?? key });
    };
    const used = new Set<string>();
    const lines: Line[] = [];
    for (const merged of MERGED) {
      const keys = merged.keys.filter((k) => known.has(k));
      if (keys.length < 2) continue;
      keys.forEach((k) => used.add(k));
      lines.push({ id: merged.id, keys, label: t(`perms.merged.${merged.id}`) });
    }
    for (const p of catalog) if (!used.has(p.permissionKey)) lines.push({ id: p.permissionKey, keys: [p.permissionKey], label: name(p.permissionKey) });
    const result = GROUPS.map((g) => ({ id: g.id, lines: [] as Line[] }));
    const other = { id: "other", lines: [] as Line[] };
    for (const line of lines) {
      const index = GROUPS.findIndex((g) => g.prefixes.some((prefix) => line.keys[0].startsWith(prefix)));
      (index >= 0 ? result[index] : other).lines.push(line);
    }
    return [...result, other].filter((g) => g.lines.length > 0);
  }, [catalog, t]);

  const granted = (line: Line) => line.keys.every((k) => effective.includes(k));
  const partly = (line: Line) => !granted(line) && line.keys.some((k) => effective.includes(k));
  const changed = (line: Line) => line.keys.some((k) => k in overrides);
  const changeable = (line: Line) => line.keys.every((k) => canChange(k));
  const anyOverride = Object.keys(overrides).length > 0;

  const confirm = async () => {
    if (!pending) return;
    if (!reason.trim()) {
      setError(t("detail.reasonRequired"));
      return;
    }
    setBusy(true);
    setError("");
    let message: string | null = null;
    if (pending.kind === "reset") {
      const result = await PermissionRepository.resetToRole(userId, reason.trim());
      if (!result.success) message = result.message ?? "";
    } else {
      for (const key of pending.line.keys) {
        const has = effective.includes(key);
        if (pending.on === has) continue;
        // back to the role's own value when the change only undoes an earlier one; otherwise an explicit grant/removal
        const result = key in overrides && overrides[key] !== pending.on
          ? await PermissionRepository.clearOverride(userId, key, reason.trim())
          : await PermissionRepository.setOverride(userId, key, pending.on, reason.trim());
        if (!result.success) {
          message = result.message ?? "";
          break;
        }
      }
    }
    setBusy(false);
    if (message !== null) {
      setError(humanizeBackendError(message, t) ?? t("detail.genericError"));
      onChanged();
      return;
    }
    setPending(null);
    setReason("");
    onChanged();
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-2)", margin: "var(--space-3) 0" }}>
        <HintText small>{t("perms.hint")}</HintText>
        {anyOverride ? (
          <Button size="sm" variant="ghost" onClick={() => { setReason(""); setError(""); setPending({ kind: "reset" }); }}>
            {t("perms.resetAll")}
          </Button>
        ) : null}
      </div>

      {groups.map((group) => {
        const total = group.lines.length;
        const on = group.lines.filter(granted).length;
        const isOpen = open === group.id;
        return (
          <section key={group.id} style={{ border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", marginBottom: "var(--space-2)", overflow: "hidden" }}>
            <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : group.id)}
              style={{ all: "unset", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", boxSizing: "border-box", padding: "var(--space-3)" }}>
              <span style={{ fontWeight: "var(--font-weight-medium)", color: "var(--text-primary)" }}>{t(`perms.groups.${group.id}`)}</span>
              <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("perms.count", { on, total })} {isOpen ? "▴" : "▾"}</span>
            </button>
            {isOpen ? (
              <div style={{ padding: "0 var(--space-3) var(--space-2)" }}>
                {group.lines.map((line) => (
                  <div key={line.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-2) 0", borderTop: "1px solid var(--border-light)" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{line.label}</div>
                      {changed(line) || partly(line) ? (
                        <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                          {partly(line) ? t("perms.partly") : t("perms.changedFromRole")}
                        </div>
                      ) : null}
                    </div>
                    <Toggle checked={granted(line)} disabled={!changeable(line)} label={line.label}
                      onChange={(next: boolean) => { setReason(""); setError(""); setPending({ kind: "line", line, on: next }); }} />
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}

      <Modal isOpen={pending !== null} onClose={() => setPending(null)}
        title={pending?.kind === "reset" ? t("perms.resetTitle") : pending?.on ? t("perms.grantTitle") : t("perms.revokeTitle")}>
        <HintText>
          {pending?.kind === "reset" ? t("perms.resetExplain") : pending ? t("perms.lineExplain", { name: pending.line.label }) : null}
        </HintText>
        {pending?.kind === "line" && pending.on && pending.line.keys.includes("hr.manage") ? <HrMoveNotice userId={userId} /> : null}
        <Input name="permission-reason" label={t("detail.reasonLabel")} value={reason} onChange={(e) => setReason(e.target.value)} required />
        {error ? <ErrorText>{error}</ErrorText> : null}
        <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end", marginTop: "var(--space-2)" }}>
          <Button variant="ghost" onClick={() => setPending(null)}>{t("perms.cancel")}</Button>
          <Button onClick={() => void confirm()} loading={busy} disabled={!reason.trim()}>{t("perms.confirm")}</Button>
        </div>
      </Modal>
    </div>
  );
}
