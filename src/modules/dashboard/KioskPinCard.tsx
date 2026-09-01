import { useState } from "react";
import { useTranslation } from "react-i18next";

import KioskRepository from "../../core/repositories/KioskRepository";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";

// PROSM Time WP-18/§13.1 - self-service kiosk PIN setup. Every
// employee who might ever use a shared kiosk device needs their own
// PIN set up in advance (kiosk_clock_in_prosm_time_attendance rejects
// identification with no PIN configured yet) - this is that one real
// entry point, distinct from the employee's own login password.
export default function KioskPinCard() {
  const { t } = useTranslation("dashboard");

  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError("");
    setSuccess(false);
    const result = await KioskRepository.setMyPin(pin);
    setSubmitting(false);
    if (!result.success) {
      setError(result.message ?? t("kioskPin.error"));
      return;
    }
    setPin("");
    setSuccess(true);
  };

  return (
    <Card title={t("kioskPin.title")}>
      <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("kioskPin.hint")}</p>
      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}
      {success ? <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{t("kioskPin.success")}</p> : null}
      <Input label={t("kioskPin.pinLabel")} name="kioskPin" type="password" value={pin} onChange={(event) => setPin(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} disabled={submitting} />
      <Button onClick={handleSubmit} loading={submitting} disabled={pin.length < 4}>
        {t("kioskPin.saveAction")}
      </Button>
    </Card>
  );
}
