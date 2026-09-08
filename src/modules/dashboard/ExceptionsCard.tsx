import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import ExceptionRepository, { type GeofenceException } from "../../core/repositories/ExceptionRepository";
import playAlertSound from "../../core/utils/playAlertSound";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";

const REASON_CATEGORIES = ["purchasing_food", "restroom", "work_assignment", "emergency", "other"];
const REFRESH_INTERVAL_MS = 60 * 1000;
const REMINDER_INTERVAL_MS = 3 * 60 * 1000;

// PROSM Time WP-11/§19 steps 3-5 - "Notify employee... allow employee
// to enter a reason." Real notification delivery is WP-13's job; this
// card is the real reason-entry surface for whatever pending
// exceptions already exist (WP-09's geofence check auto-creates them
// at Clock In/Out, and now also a mid-shift geofence exit - § live UX
// review, user-directed). Polls for new ones (a mid-shift exit can
// appear while this card is already on screen) and, while any remain
// unresolved, re-plays the alert sound on a timer - the "scheduled
// reminder" the same request asked for, reusing the one sound utility
// rather than a second alert mechanism.
export default function ExceptionsCard() {
  const { t } = useTranslation("dashboard");
  const { profile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const targetExceptionId = searchParams.get("exceptionId");

  const [exceptions, setExceptions] = useState<GeofenceException[]>([]);
  const [reasonCategory, setReasonCategory] = useState<Record<string, string>>({});
  const [reasonText, setReasonText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const entryRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const hasScrolledToTargetRef = useRef(false);

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

  useEffect(() => {
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (exceptions.length === 0) return undefined;
    const interval = setInterval(playAlertSound, REMINDER_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [exceptions.length]);

  // § real bug fix, user-reported - "the notification doesn't lead the
  // employee to a specific place to write the reason." NotificationBell
  // now routes an out-of-zone notification to /dashboard?exceptionId=...;
  // this scrolls straight to and highlights that exact pending
  // exception's reason field the moment it's loaded, instead of leaving
  // the employee to scroll past every other Dashboard card to find it.
  useEffect(() => {
    if (hasScrolledToTargetRef.current || !targetExceptionId || exceptions.length === 0) return;
    const target = exceptions.find((exception) => exception.id === targetExceptionId);
    if (!target) return;
    hasScrolledToTargetRef.current = true;
    entryRefs.current[target.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedId(target.id);
    const params = new URLSearchParams(searchParams);
    params.delete("exceptionId");
    setSearchParams(params, { replace: true });
    const timeout = window.setTimeout(() => setHighlightedId(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [exceptions, targetExceptionId, searchParams, setSearchParams]);

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
      setError(humanizeBackendError(result.message, t) ?? t("exceptions.submitError"));
      return;
    }

    load();
  };

  return (
    <Card title={t("exceptions.title")}>
      <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("exceptions.hint")}</p>
      <ErrorText>{error}</ErrorText>

      {exceptions.map((exception) => (
        <div
          key={exception.id}
          ref={(element) => {
            entryRefs.current[exception.id] = element;
          }}
          style={{
            borderTop: "1px solid var(--border-light)",
            paddingTop: "var(--space-3)",
            marginTop: "var(--space-3)",
            borderRadius: "var(--radius-md)",
            transition: "background-color 0.4s ease",
            backgroundColor: highlightedId === exception.id ? "var(--surface-hover)" : "transparent",
            boxShadow: highlightedId === exception.id ? "0 0 0 2px var(--brand-primary)" : "none",
          }}
        >
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
