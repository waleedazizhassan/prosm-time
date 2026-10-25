import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import LeaveRepository, { type LeaveTypeSetting } from "../../core/repositories/LeaveRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import leaveTypeLabel from "../leave/leaveTypeLabel";

import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Toggle from "../../components/common/Toggle";
import Modal from "../../components/common/Modal";
import ListRow from "../../components/common/ListRow";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

type Draft = {
  id: string | null;
  key: string;
  name: string;
  isPaid: boolean;
  annualDays: string;
  tiers: string;
  specialNeedsDays: string;
  enforceBalance: boolean;
  maxDaysPerRequest: string;
  maxTimesInService: string;
  minServiceYears: string;
  requiresDocument: boolean;
  isActive: boolean;
};

const numOrNull = (value: string) => (value.trim() === "" ? null : Number(value));

// "0:15, 1:21, 10:30" <-> [{minYears, days}]
const tiersToText = (tiers: LeaveTypeSetting["serviceTiers"]) => (tiers ?? []).map((tier) => `${tier.minYears}:${tier.days}`).join(", ");
function textToTiers(text: string): { minYears: number; days: number }[] | null {
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.map((part) => {
    const [years, days] = part.split(":").map(Number);
    return { minYears: years, days };
  });
}

// v2.3.43 step 7 (item 25): the organisation's leave types (leave.manage_types).
// Changes apply to coming entitlements only; balances already set stay.
export default function LeaveTypesSettingsCard() {
  const { t } = useTranslation("settings");
  const [types, setTypes] = useState<LeaveTypeSetting[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const result = await LeaveRepository.listTypes();
    setTypes(result.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (type: LeaveTypeSetting | null) => {
    setError("");
    setDraft(
      type
        ? {
            id: type.id,
            key: type.key,
            name: type.name,
            isPaid: type.isPaid,
            annualDays: type.annualDays === null ? "" : String(type.annualDays),
            tiers: tiersToText(type.serviceTiers),
            specialNeedsDays: type.specialNeedsDays === null ? "" : String(type.specialNeedsDays),
            enforceBalance: type.enforceBalance,
            maxDaysPerRequest: type.maxDaysPerRequest === null ? "" : String(type.maxDaysPerRequest),
            maxTimesInService: type.maxTimesInService === null ? "" : String(type.maxTimesInService),
            minServiceYears: type.minServiceYears === null ? "" : String(type.minServiceYears),
            requiresDocument: type.requiresDocument,
            isActive: type.isActive,
          }
        : { id: null, key: "", name: "", isPaid: true, annualDays: "", tiers: "", specialNeedsDays: "", enforceBalance: false, maxDaysPerRequest: "", maxTimesInService: "", minServiceYears: "", requiresDocument: false, isActive: true },
    );
  };

  const handleSave = async () => {
    if (!draft) return;
    const tiers = textToTiers(draft.tiers);
    if (tiers && tiers.some((tier) => Number.isNaN(tier.minYears) || Number.isNaN(tier.days))) {
      setError(t("leaveTypes.invalidTiers"));
      return;
    }
    setSaving(true);
    setError("");
    const result = await LeaveRepository.saveType(draft.id, draft.key, {
      name: draft.name,
      isPaid: draft.isPaid,
      annualDays: numOrNull(draft.annualDays),
      serviceTiers: tiers,
      specialNeedsDays: numOrNull(draft.specialNeedsDays),
      enforceBalance: draft.enforceBalance,
      maxDaysPerRequest: numOrNull(draft.maxDaysPerRequest),
      maxTimesInService: numOrNull(draft.maxTimesInService),
      minServiceYears: numOrNull(draft.minServiceYears),
      requiresDocument: draft.requiresDocument,
      isActive: draft.isActive,
    });
    setSaving(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("leaveTypes.genericError"));
      return;
    }
    setDraft(null);
    await load();
  };

  const toggleRow = (label: string, checked: boolean, onChange: (value: boolean) => void) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-1) 0" }}>
      <span style={{ fontSize: "var(--font-sm)" }}>{label}</span>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );

  return (
    <Card
      title={t("leaveTypes.title")}
      actions={
        <Button size="sm" variant="ghost" onClick={() => open(null)}>
          {t("leaveTypes.add")}
        </Button>
      }
    >
      <HintText small>{t("leaveTypes.hint")}</HintText>
      {types.map((type) => (
        <ListRow key={type.id}>
          <div>
            <div style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: type.isActive ? "var(--text-primary)" : "var(--text-secondary)" }}>
              {leaveTypeLabel(t, type.key, type.name)}
              {type.isActive ? "" : ` · ${t("leaveTypes.inactive")}`}
            </div>
            <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
              {[
                type.isPaid ? t("leaveTypes.paid") : t("leaveTypes.unpaid"),
                type.serviceTiers ? t("leaveTypes.tiersSummary", { tiers: tiersToText(type.serviceTiers) }) : type.annualDays !== null ? t("leaveTypes.daysSummary", { days: type.annualDays }) : null,
                type.maxDaysPerRequest ? t("leaveTypes.maxPerRequestSummary", { days: type.maxDaysPerRequest }) : null,
                type.requiresDocument ? t("leaveTypes.documentSummary") : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {type.legalNote ? <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{type.legalNote}</div> : null}
          </div>
          <Button size="sm" variant="ghost" onClick={() => open(type)}>
            {t("leaveTypes.edit")}
          </Button>
        </ListRow>
      ))}

      <Modal
        isOpen={Boolean(draft)}
        onClose={() => setDraft(null)}
        title={draft?.id ? t("leaveTypes.edit") : t("leaveTypes.add")}
        footer={
          <Button onClick={handleSave} loading={saving}>
            {t("leaveTypes.save")}
          </Button>
        }
      >
        {draft ? (
          <>
            {draft.id ? null : <Input label={t("leaveTypes.key")} name="leaveTypeKey" value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} helperText={t("leaveTypes.keyHint")} />}
            <Input label={t("leaveTypes.name")} name="leaveTypeName" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            {toggleRow(t("leaveTypes.paidLabel"), draft.isPaid, (value) => setDraft({ ...draft, isPaid: value }))}
            <Input label={t("leaveTypes.annualDays")} name="leaveTypeDays" type="number" value={draft.annualDays} onChange={(event) => setDraft({ ...draft, annualDays: event.target.value })} />
            <Input label={t("leaveTypes.tiers")} name="leaveTypeTiers" value={draft.tiers} onChange={(event) => setDraft({ ...draft, tiers: event.target.value })} helperText={t("leaveTypes.tiersHint")} />
            <Input label={t("leaveTypes.specialNeedsDays")} name="leaveTypeSpecial" type="number" value={draft.specialNeedsDays} onChange={(event) => setDraft({ ...draft, specialNeedsDays: event.target.value })} />
            {toggleRow(t("leaveTypes.enforceBalance"), draft.enforceBalance, (value) => setDraft({ ...draft, enforceBalance: value }))}
            <Input label={t("leaveTypes.maxDaysPerRequest")} name="leaveTypeMax" type="number" value={draft.maxDaysPerRequest} onChange={(event) => setDraft({ ...draft, maxDaysPerRequest: event.target.value })} />
            <Input label={t("leaveTypes.maxTimesInService")} name="leaveTypeTimes" type="number" value={draft.maxTimesInService} onChange={(event) => setDraft({ ...draft, maxTimesInService: event.target.value })} />
            <Input label={t("leaveTypes.minServiceYears")} name="leaveTypeService" type="number" value={draft.minServiceYears} onChange={(event) => setDraft({ ...draft, minServiceYears: event.target.value })} />
            {toggleRow(t("leaveTypes.requiresDocument"), draft.requiresDocument, (value) => setDraft({ ...draft, requiresDocument: value }))}
            {toggleRow(t("leaveTypes.active"), draft.isActive, (value) => setDraft({ ...draft, isActive: value }))}
            <ErrorText>{error}</ErrorText>
          </>
        ) : null}
      </Modal>
    </Card>
  );
}
