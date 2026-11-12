import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import PayrollCycleRepository, { type MyPayslip, type PayslipRequest } from "../../core/repositories/PayrollCycleRepository";
import { formatDateOnly } from "../../core/utils/formatDate";
import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import Textarea from "../../components/common/Textarea";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import LoadingState from "../../components/common/LoadingState";
import PayslipLines from "./PayslipLines";
import { payrollError } from "./payrollUi";
import usePayrollDigits from "./usePayrollDigits";

// Owner 2026-11-12: "one tap on the request opens a card with a preview, send and reject. Send reaches the
// employee by notification and email; reject sends a rejection notification." The preview is the stored,
// published payslip exactly as the employee would see it.
export default function PayslipRequestModal({ request, onClose, onDone }: { request: PayslipRequest | null; onClose: () => void; onDone: (message: string) => void }) {
  const { t, i18n } = useTranslation("payroll");
  usePayrollDigits();
  const [preview, setPreview] = useState<MyPayslip | null>(null);
  const [error, setError] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"" | "send" | "reject">("");

  useEffect(() => {
    setPreview(null);
    setError("");
    setRejecting(false);
    setReason("");
    if (!request || !request.cyclePublished) return;
    let live = true;
    void PayrollCycleRepository.previewRequest(request.id).then((result) => {
      if (!live) return;
      if (result.error) setError(payrollError(result.error, t));
      setPreview(result.data);
    });
    return () => {
      live = false;
    };
  }, [request, t]);

  const send = async () => {
    if (!request) return;
    setBusy("send");
    setError("");
    const result = await PayrollCycleRepository.sendPayslip(request.id);
    setBusy("");
    if (result.error) return setError(payrollError(result.error, t));
    onDone(t("requests.sentTo", { email: request.email, name: request.fullName }));
  };

  const reject = async () => {
    if (!request) return;
    if (!reason.trim()) return setError(t("requests.reasonRequired"));
    setBusy("reject");
    setError("");
    const result = await PayrollCycleRepository.rejectRequest(request.id, reason.trim());
    setBusy("");
    if (result.error) return setError(payrollError(result.error, t));
    onDone(t("requests.rejectedNotice", { name: request.fullName }));
  };

  const open = request && request.status !== "sent" && request.status !== "rejected";
  return (
    <Modal isOpen={Boolean(request)} onClose={onClose} size="lg"
      title={request ? t("requests.reviewTitle", { name: request.fullName, cycle: request.cycleTitle }) : ""}
      footer={open ? (
        rejecting ? (
          <>
            <Button variant="ghost" onClick={() => setRejecting(false)} disabled={busy !== ""}>{t("requests.back")}</Button>
            <Button variant="danger" loading={busy === "reject"} onClick={reject}>{t("requests.reject")}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setRejecting(true)} disabled={busy !== ""}>{t("requests.reject")}</Button>
            <Button loading={busy === "send"} disabled={!request?.cyclePublished || request?.sending} onClick={send}>{t("requests.sendNow")}</Button>
          </>
        )
      ) : undefined}>
      {request ? (
        <>
          <HintText small>
            {`${formatDateOnly(request.periodStart, i18n.language)} - ${formatDateOnly(request.periodEnd, i18n.language)} · ${t("requests.askedOn", { date: formatDateOnly(request.createdAt.slice(0, 10), i18n.language) })}`}
            {request.note ? ` · ${request.note}` : ""}
          </HintText>
          {open ? <HintText small>{t("requests.sendExplain", { email: request.email })}</HintText> : null}
          {request.status === "rejected" && request.rejectionReason ? <HintText small>{t("requests.rejectedWith", { reason: request.rejectionReason })}</HintText> : null}
          {!request.cyclePublished ? <HintText>{t("requests.notPublished")}</HintText> : preview ? <PayslipLines payslip={preview} /> : error ? null : <LoadingState />}
          {rejecting ? <Textarea label={t("requests.reasonLabel")} name="payslipRejectReason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} /> : null}
          <ErrorText>{error}</ErrorText>
        </>
      ) : null}
    </Modal>
  );
}
