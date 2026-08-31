import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import ExceptionRepository, { type GeofenceException } from "../../core/repositories/ExceptionRepository";

import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Button from "../../components/common/Button";

const REASON_CATEGORIES = ["purchasing_food", "restroom", "work_assignment", "emergency", "other"];

// PROSM Time WP-11/§19 steps 3-5 - "Notify employee... allow employee
// to enter a reason." Real notification delivery is WP-13's job; this
// card is the real reason-entry surface for whatever pending
// exceptions already exist (WP-09's geofence check auto-creates them).
export default function ExceptionsCard() {
  const { t } = useTranslation("dashboard");
  const { profile } = useAuth();

  const [exceptions, setExceptions] = useState<GeofenceException[]>([]);
  const [reasonCategory, setReasonCategory] = useState<Record<string, string>>({});
  const [reasonText, setReasonText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    const result = await ExceptionRepository.listPendingReasonExceptions(profile.id);
    setExceptions(result.success ? result.data ?? [] : []);
    setLoading(false);
  }, [profile]);

  useEffect(() => {
    load();
  }, [load]);

  if (!profile || loading || exceptions.length === 0) return null;

  const handleSubmit = async (exceptionId: string) => {
    const category = reasonCategory[exceptionId] ?? REASON_CATEGORIES[0];
    const reason = (reasonText[exceptionId] ?? "").trim();
    if (!reason) return;

    setSubmitting(exceptionId);
    setError("");

    const result = await ExceptionRepository.submitReason(exceptionId, category, reason);

    setSubmitting(null);

    if (!result.success) {
      setError(result.message ?? t("exceptions.submitError"));
      return;
    }

    load();
  };

  return (
    <Card title={t("exceptions.title")}>
      <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("exceptions.hint")}</p>
      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}

      {exceptions.map((exception) => (
        <div key={exception.id} style={{ borderTop: "1px solid var(--border-light)", paddingTop: "var(--space-3)", marginTop: "var(--space-3)" }}>
          <p style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("exceptions.outsideZone", { distance: Math.round(exception.distanceMeters) })}</p>
          <Select
            label={t("exceptions.reasonCategoryLabel")}
            name={`reasonCategory-${exception.id}`}
            value={reasonCategory[exception.id] ?? REASON_CATEGORIES[0]}
            onChange={(event) => setReasonCategory((current) => ({ ...current, [exception.id]: event.target.value }))}
            disabled={submitting === exception.id}
            options={REASON_CATEGORIES.map((category) => ({ value: category, label: t(`exceptions.category.${category}`) }))}
          />
          <Textarea
            label={t("exceptions.reasonLabel")}
            name={`reasonText-${exception.id}`}
            value={reasonText[exception.id] ?? ""}
            onChange={(event) => setReasonText((current) => ({ ...current, [exception.id]: event.target.value }))}
            required
            disabled={submitting === exception.id}
          />
          <Button onClick={() => handleSubmit(exception.id)} loading={submitting === exception.id} disabled={!(reasonText[exception.id] ?? "").trim()}>
            {t("exceptions.submitAction")}
          </Button>
        </div>
      ))}
    </Card>
  );
}
