import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import AttendanceControlRepository, { type PermissionKind } from "../../core/repositories/AttendanceControlRepository";
import DatabaseManager from "../../core/database/DatabaseManager";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import ListRow from "../../components/common/ListRow";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

const KINDS: PermissionKind[] = ["late_arrival", "early_leave", "approved_overtime"];

interface MyPermission {
  id: string;
  work_date: string;
  kind: PermissionKind;
  minutes: number | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  paid: boolean;
  reason: string;
  review_notes: string | null;
}

// v2.3.43 step 6 (item 23): the employee asks for a permission in advance
// (late arrival, early leave, overtime) and sees each decision and why there
// was, or was not, a deduction.
export default function PermissionRequestCard() {
  const { t, i18n } = useTranslation("leave");
  const { profile } = useAuth();
  const [kind, setKind] = useState<PermissionKind>("late_arrival");
  const [date, setDate] = useState("");
  const [minutes, setMinutes] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mine, setMine] = useState<MyPermission[]>([]);

  const load = useCallback(async () => {
    if (!profile?.id) return;
    const { data } = await DatabaseManager.getClient()
      .from("attendance_permissions")
      .select("id, work_date, kind, minutes, status, paid, reason, review_notes")
      .eq("user_id", profile.id)
      .order("work_date", { ascending: false })
      .limit(10);
    setMine((data ?? []) as MyPermission[]);
  }, [profile?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSubmit = async () => {
    if (!date || !reason.trim()) {
      setError(t("permission.required"));
      return;
    }
    setBusy(true);
    setError("");
    const result = await AttendanceControlRepository.request(date, kind, minutes ? Number(minutes) : null, reason.trim());
    setBusy(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("permission.genericError"));
      return;
    }
    setDate("");
    setMinutes("");
    setReason("");
    await load();
  };

  const handleCancel = async (id: string) => {
    const result = await AttendanceControlRepository.cancel(id);
    if (!result.success) setError(humanizeBackendError(result.message, t) ?? t("permission.genericError"));
    await load();
  };

  return (
    <Card title={t("permission.title")}>
      <HintText small>{t("permission.hint")}</HintText>
      <Select label={t("permission.kindLabel")} name="permissionKind" value={kind} onChange={(event) => setKind(event.target.value as PermissionKind)} options={KINDS.map((option) => ({ value: option, label: t(`permission.kind.${option}`) }))} />
      <Input label={t("permission.dateLabel")} name="permissionDate" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      <Input label={t("permission.minutesLabel")} name="permissionMinutes" type="number" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
      <Textarea label={t("permission.reasonLabel")} name="permissionReason" value={reason} onChange={(event) => setReason(event.target.value)} />
      <ErrorText>{error}</ErrorText>
      <Button onClick={handleSubmit} loading={busy}>
        {t("permission.submit")}
      </Button>
      {mine.length > 0 ? (
        <div style={{ marginTop: "var(--space-3)" }}>
          {mine.map((row) => (
            <ListRow key={row.id}>
              <div>
                <div style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)", fontWeight: "var(--font-weight-semibold)" }}>
                  {t(`permission.kind.${row.kind}`)} · {formatDateOnly(row.work_date, i18n.language)} · {t(`permission.status.${row.status}`)}
                  {row.status === "approved" && (row.kind === "late_arrival" || row.kind === "early_leave") ? ` · ${row.paid ? t("permission.noDeduction") : t("permission.partialDeduction")}` : ""}
                </div>
                <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{row.review_notes ?? row.reason}</div>
              </div>
              {row.status === "pending" ? (
                <Button size="sm" variant="ghost" onClick={() => void handleCancel(row.id)}>
                  {t("permission.cancel")}
                </Button>
              ) : null}
            </ListRow>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
