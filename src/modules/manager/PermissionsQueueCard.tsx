import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import AttendanceControlRepository, { type OvertimeAwaiting, type PermissionKind, type PermissionRequest } from "../../core/repositories/AttendanceControlRepository";
import EmployeeRepository from "../../core/repositories/EmployeeRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Toggle from "../../components/common/Toggle";
import ListRow from "../../components/common/ListRow";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import PersonName from "../../components/common/PersonName";

const KINDS: PermissionKind[] = ["late_arrival", "early_leave", "approved_overtime", "no_overtime"];

export function formatHm(minutes: number): string {
  const total = Math.round(minutes);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

type Decision = { request: PermissionRequest; action: "approved" | "rejected" };
type Grant = { userId: string; workDate: string; kind: PermissionKind; minutes: string; paid: boolean; deductionPercent: string; deductionMinutes: string; reason: string };
type Adjust = { userId: string; name: string; workDate: string; overtime: string; late: string; deduction: string; reason: string };

// v2.3.43 step 6 (item 23): what waits for the manager about time - permission
// requests (approve as paid or with a partial deduction, or reject), days whose
// overtime waits for approval, granting a permission (also afterwards) and
// adjusting a day's minutes. Reasons are required; the server audits and
// refuses a day of an approved period.
export default function PermissionsQueueCard() {
  const { t, i18n } = useTranslation("manager");
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  const [overtime, setOvertime] = useState<OvertimeAwaiting[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [paid, setPaid] = useState(true);
  const [percent, setPercent] = useState("");
  const [notes, setNotes] = useState("");
  const [grant, setGrant] = useState<Grant | null>(null);
  const [adjust, setAdjust] = useState<Adjust | null>(null);

  const load = useCallback(async () => {
    const result = await AttendanceControlRepository.queue();
    if (!result.success) setError(humanizeBackendError(result.message, t) ?? t("permissions.loadError"));
    setRequests(result.data?.requests ?? []);
    setOvertime(result.data?.overtime ?? []);
  }, [t]);

  useEffect(() => {
    void load();
    EmployeeRepository.listOrganizationMembers().then((result) =>
      setPeople((result.data ?? []).filter((member) => !member.isOwner && member.isActive).map((member) => ({ id: member.id, name: member.fullName }))),
    );
  }, [load]);

  const run = async (action: () => Promise<{ success: boolean; message: string | null }>, done: () => void) => {
    setBusy(true);
    setError("");
    const result = await action();
    setBusy(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("permissions.genericError"));
      return;
    }
    done();
    await load();
  };

  const day = (iso: string) => formatDateOnly(iso, i18n.language);

  return (
    <Card
      title={t("permissions.title", { count: requests.length + overtime.length })}
      actions={
        <Button size="sm" variant="ghost" onClick={() => setGrant({ userId: people[0]?.id ?? "", workDate: "", kind: "late_arrival", minutes: "", paid: true, deductionPercent: "", deductionMinutes: "", reason: "" })}>
          {t("permissions.grantAction")}
        </Button>
      }
    >
      <HintText small>{t("permissions.hint")}</HintText>
      <ErrorText>{error}</ErrorText>
      {requests.length === 0 && overtime.length === 0 ? <HintText small>{t("permissions.empty")}</HintText> : null}

      {requests.map((request) => (
        <ListRow key={request.id}>
          <div>
            <div style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>
              <PersonName name={request.employeeName} url={request.avatarUrl}>{request.employeeName} — {t(`permissions.kind.${request.kind}`)}</PersonName> · {day(request.workDate)}
              {request.minutes ? ` · ${formatHm(request.minutes)}` : ""}
            </div>
            <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{request.reason}</div>
          </div>
          <div style={{ display: "flex", gap: "var(--space-1)" }}>
            <Button size="sm" variant="ghost" onClick={() => { setDecision({ request, action: "rejected" }); setNotes(""); }}>
              {t("pending.action.rejected")}
            </Button>
            <Button size="sm" onClick={() => { setDecision({ request, action: "approved" }); setPaid(true); setPercent(""); setNotes(""); }}>
              {t("pending.action.approved")}
            </Button>
          </div>
        </ListRow>
      ))}

      {overtime.map((row) => (
        <ListRow key={`${row.userId}-${row.day}`}>
          <div>
            <div style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>
              <PersonName name={row.employeeName} url={row.avatarUrl} />{" "}— {t("permissions.overtimeWaiting", { time: formatHm(row.overtimePendingApprovalMinutes) })} · {day(row.day)}
            </div>
            <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t(`permissions.dayType.${row.dayType}`)}</div>
          </div>
          <div style={{ display: "flex", gap: "var(--space-1)" }}>
            <Button size="sm" variant="ghost" onClick={() => setAdjust({ userId: row.userId, name: row.employeeName, workDate: row.day, overtime: String(Math.round(row.overtimePendingApprovalMinutes)), late: "", deduction: "", reason: "" })}>
              {t("permissions.adjustAction")}
            </Button>
            <Button
              size="sm"
              loading={busy}
              onClick={() => void run(() => AttendanceControlRepository.adjustDay(row.userId, row.day, { overtimeApproved: true }, t("permissions.approvedOvertimeReason")), () => undefined)}
            >
              {t("permissions.approveOvertime")}
            </Button>
          </div>
        </ListRow>
      ))}

      <Modal
        isOpen={Boolean(decision)}
        onClose={() => setDecision(null)}
        title={decision ? `${decision.request.employeeName} — ${t(`permissions.kind.${decision.request.kind}`)}` : ""}
        footer={
          <Button
            variant={decision?.action === "rejected" ? "danger" : "primary"}
            loading={busy}
            onClick={() =>
              decision &&
              void run(
                () => AttendanceControlRepository.review(decision.request.id, decision.action, paid, paid || !percent ? null : Number(percent), null, notes.trim()),
                () => setDecision(null),
              )
            }
          >
            {decision ? t(`pending.action.${decision.action}`) : ""}
          </Button>
        }
      >
        {decision?.action === "approved" && (decision.request.kind === "late_arrival" || decision.request.kind === "early_leave") ? (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0" }}>
              <span style={{ fontSize: "var(--font-sm)" }}>{t("permissions.paidLabel")}</span>
              <Toggle checked={paid} onChange={setPaid} label={t("permissions.paidLabel")} />
            </div>
            {!paid ? <Input label={t("permissions.deductionPercentLabel")} name="permissionPercent" type="number" value={percent} onChange={(event) => setPercent(event.target.value)} /> : null}
          </>
        ) : null}
        <Textarea label={t("pending.notesLabel")} name="permissionNotes" value={notes} onChange={(event) => setNotes(event.target.value)} />
        <ErrorText>{error}</ErrorText>
      </Modal>

      <Modal
        isOpen={Boolean(grant)}
        onClose={() => setGrant(null)}
        title={t("permissions.grantAction")}
        footer={
          <Button
            loading={busy}
            onClick={() =>
              grant &&
              void run(
                () =>
                  AttendanceControlRepository.grant(
                    grant.userId,
                    grant.workDate,
                    grant.kind,
                    grant.minutes ? Number(grant.minutes) : null,
                    grant.paid,
                    grant.paid || !grant.deductionPercent ? null : Number(grant.deductionPercent),
                    grant.paid || !grant.deductionMinutes ? null : Number(grant.deductionMinutes),
                    grant.reason.trim(),
                  ),
                () => setGrant(null),
              )
            }
          >
            {t("permissions.save")}
          </Button>
        }
      >
        {grant ? (
          <>
            <Select label={t("permissions.personLabel")} name="grantPerson" value={grant.userId} onChange={(event) => setGrant({ ...grant, userId: event.target.value })} options={people.map((person) => ({ value: person.id, label: person.name }))} />
            <Input label={t("permissions.dateLabel")} name="grantDate" type="date" value={grant.workDate} onChange={(event) => setGrant({ ...grant, workDate: event.target.value })} />
            <Select label={t("permissions.kindLabel")} name="grantKind" value={grant.kind} onChange={(event) => setGrant({ ...grant, kind: event.target.value as PermissionKind })} options={KINDS.map((kind) => ({ value: kind, label: t(`permissions.kind.${kind}`) }))} />
            <Input label={t("permissions.minutesLabel")} name="grantMinutes" type="number" value={grant.minutes} onChange={(event) => setGrant({ ...grant, minutes: event.target.value })} />
            {grant.kind === "late_arrival" || grant.kind === "early_leave" ? (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0" }}>
                  <span style={{ fontSize: "var(--font-sm)" }}>{t("permissions.paidLabel")}</span>
                  <Toggle checked={grant.paid} onChange={(checked) => setGrant({ ...grant, paid: checked })} label={t("permissions.paidLabel")} />
                </div>
                {!grant.paid ? (
                  <>
                    <Input label={t("permissions.deductionPercentLabel")} name="grantPercent" type="number" value={grant.deductionPercent} onChange={(event) => setGrant({ ...grant, deductionPercent: event.target.value })} />
                    <Input label={t("permissions.deductionMinutesLabel")} name="grantDeductMinutes" type="number" value={grant.deductionMinutes} onChange={(event) => setGrant({ ...grant, deductionMinutes: event.target.value })} />
                  </>
                ) : null}
              </>
            ) : null}
            <Textarea label={t("permissions.reasonLabel")} name="grantReason" value={grant.reason} onChange={(event) => setGrant({ ...grant, reason: event.target.value })} />
            <ErrorText>{error}</ErrorText>
          </>
        ) : null}
      </Modal>

      <Modal
        isOpen={Boolean(adjust)}
        onClose={() => setAdjust(null)}
        title={adjust ? `${adjust.name} — ${t("permissions.adjustTitle")} · ${day(adjust.workDate)}` : ""}
        footer={
          <Button
            loading={busy}
            onClick={() =>
              adjust &&
              void run(
                () =>
                  AttendanceControlRepository.adjustDay(
                    adjust.userId,
                    adjust.workDate,
                    {
                      overtimeMinutes: adjust.overtime === "" ? null : Number(adjust.overtime),
                      lateMinutes: adjust.late === "" ? null : Number(adjust.late),
                      deductionMinutes: adjust.deduction === "" ? null : Number(adjust.deduction),
                    },
                    adjust.reason.trim(),
                  ),
                () => setAdjust(null),
              )
            }
          >
            {t("permissions.save")}
          </Button>
        }
      >
        {adjust ? (
          <>
            <HintText small>{t("permissions.adjustHint")}</HintText>
            <Input label={t("permissions.overtimeMinutesLabel")} name="adjustOvertime" type="number" value={adjust.overtime} onChange={(event) => setAdjust({ ...adjust, overtime: event.target.value })} />
            <Input label={t("permissions.lateMinutesLabel")} name="adjustLate" type="number" value={adjust.late} onChange={(event) => setAdjust({ ...adjust, late: event.target.value })} />
            <Input label={t("permissions.deductionMinutesLabel")} name="adjustDeduction" type="number" value={adjust.deduction} onChange={(event) => setAdjust({ ...adjust, deduction: event.target.value })} />
            <Textarea label={t("permissions.reasonLabel")} name="adjustReason" value={adjust.reason} onChange={(event) => setAdjust({ ...adjust, reason: event.target.value })} />
            <ErrorText>{error}</ErrorText>
          </>
        ) : null}
      </Modal>
    </Card>
  );
}
