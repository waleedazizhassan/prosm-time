import { useState } from "react";
import { useTranslation } from "react-i18next";

import { requireSupabaseClient } from "../../core/api/supabaseClient";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import SuccessText from "../../components/common/SuccessText";
import useConfirm from "../../components/common/useConfirm";

// Owner 2026-11-16: every employee's code is 5 sequential digits by hiring seniority, given the moment a hiring date is
// entered. After entering older hiring dates, the owner numbers everyone again by seniority here.
export default function EmployeeCodesCard() {
  const { t } = useTranslation("settings");
  const [confirm, confirmDialog] = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<number | null>(null);

  const renumber = async () => {
    if (!(await confirm(t("employeeCodes.confirm")))) return;
    setBusy(true);
    setError("");
    setDone(null);
    const { data, error: e } = await requireSupabaseClient().rpc("renumber_prosm_time_employee_codes");
    setBusy(false);
    if (e) {
      setError(humanizeBackendError(e.message, t) ?? t("employeeCodes.failed"));
      return;
    }
    setDone(Number((data as { numbered?: number } | null)?.numbered ?? 0));
  };

  return (
    <Card title={t("employeeCodes.title")} subtitle={t("employeeCodes.subtitle")}>
      <HintText small>{t("employeeCodes.hint")}</HintText>
      <div>
        <Button variant="ghost" onClick={() => void renumber()} loading={busy}>{t("employeeCodes.renumber")}</Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {done !== null ? <SuccessText>{t("employeeCodes.done", { count: done })}</SuccessText> : null}
      {confirmDialog}
    </Card>
  );
}
