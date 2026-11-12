import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";

import PayrollCycleRepository, { type PayslipRequest } from "../../core/repositories/PayrollCycleRepository";
import { formatDateOnly } from "../../core/utils/formatDate";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import ListRow from "../../components/common/ListRow";
import SuccessText from "../../components/common/SuccessText";
import PayslipRequestModal from "../payroll/PayslipRequestModal";

// Owner 2026-11-12: the payslip requests on the manager page - each opens the card with the preview, send
// and reject. A notification opens its request directly (?payslipRequest=<id>). Nothing open, no card.
export default function PayslipRequestsCard() {
  const { t, i18n } = useTranslation("payroll");
  const [searchParams, setSearchParams] = useSearchParams();
  const [requests, setRequests] = useState<PayslipRequest[]>([]);
  const [open, setOpen] = useState<PayslipRequest | null>(null);
  const [notice, setNotice] = useState("");
  const wanted = searchParams.get("payslipRequest");

  const load = useCallback(async () => {
    const result = await PayrollCycleRepository.listRequests(null);
    const all = result.data ?? [];
    setRequests(all.filter((r) => r.status === "pending" || r.status === "failed"));
    return all;
  }, []);

  useEffect(() => {
    void load().then((all) => {
      if (!wanted) return;
      const hit = all.find((r) => r.id === wanted);
      if (hit) setOpen(hit);
    });
  }, [load, wanted]);

  const close = () => {
    setOpen(null);
    if (wanted) setSearchParams((params) => { params.delete("payslipRequest"); return params; }, { replace: true });
  };

  if (requests.length === 0 && !open && !notice) return null;
  return (
    <Card title={t("requests.cardTitle", { count: requests.length })} actions={<Link to="/payroll/requests" style={{ color: "var(--text-link)", fontSize: "var(--font-sm)" }}>{t("requests.allRequests")}</Link>}>
      {notice ? <SuccessText>{notice}</SuccessText> : null}
      {requests.map((r) => (
        <ListRow key={r.id}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ display: "block" }}>{r.fullName}</strong>
            <small style={{ color: "var(--text-secondary)" }}>
              {`${r.cycleTitle} · ${t("requests.askedOn", { date: formatDateOnly(r.createdAt.slice(0, 10), i18n.language) })}${r.note ? ` · ${r.note}` : ""}${r.status === "failed" ? ` · ${t("requests.statuses.failed")}` : ""}`}
            </small>
          </span>
          <Button size="sm" onClick={() => { setNotice(""); setOpen(r); }}>{t("requests.review")}</Button>
        </ListRow>
      ))}
      <PayslipRequestModal request={open} onClose={close} onDone={(message) => { close(); setNotice(message); void load(); }} />
    </Card>
  );
}
