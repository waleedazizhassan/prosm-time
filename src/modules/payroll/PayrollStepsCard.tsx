import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Circle, AlertTriangle } from "lucide-react";

import PayrollCycleRepository from "../../core/repositories/PayrollCycleRepository";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";

// Owner 2026-11-09 ("the payroll cycle is still unclear - simplify it"): the three steps on the
// payroll home, each with where it stands and the button that does it.
export default function PayrollStepsCard({ canSettings, canProfiles, cycles }: { canSettings: boolean; canProfiles: boolean; cycles: number }) {
  const { t } = useTranslation("payroll");
  const navigate = useNavigate();
  const [state, setState] = useState<{ components: number; basic: boolean; statutory: boolean; people: number; withProfile: number } | null>(null);

  useEffect(() => {
    void (async () => {
      const [components, people, statutory] = await Promise.all([
        PayrollCycleRepository.listComponents(),
        canProfiles ? PayrollCycleRepository.listProfiles() : Promise.resolve({ data: null, error: null }),
        PayrollCycleRepository.getStatutory(),
      ]);
      const list = components.data ?? [];
      const cfg = statutory.data?.config;
      setState({
        components: list.filter((c) => c.is_active).length,
        basic: list.some((c) => c.is_basic && c.is_active),
        statutory: Boolean(cfg?.insurance?.enabled || cfg?.incomeTax?.enabled),
        people: (people.data ?? []).filter((p) => p.isActive).length,
        withProfile: (people.data ?? []).filter((p) => p.isActive && p.profile?.is_active && p.components.length > 0).length,
      });
    })();
  }, [canProfiles]);

  if (!state) return null;
  const step1 = state.basic;
  const step2 = state.withProfile > 0;
  const step3 = cycles > 0;
  const row = (done: boolean, warn: boolean, n: number, title: string, text: string, action: { label: string; to: string } | null) => (
    <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start", padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)" }}>
      <span style={{ marginTop: 2, color: done ? "var(--status-success-text, #16a34a)" : warn ? "#d97706" : "var(--text-secondary)" }} aria-hidden="true">
        {done ? <CheckCircle2 size={22} /> : warn ? <AlertTriangle size={22} /> : <Circle size={22} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{n}. {title}</strong>
        <div style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{text}</div>
      </div>
      {action ? <Button size="sm" variant={done ? "ghost" : "primary"} onClick={() => navigate(action.to)}>{action.label}</Button> : null}
    </div>
  );

  return (
    <Card title={t("steps.title")} subtitle={t("steps.hint")}>
      {row(step1, !step1, 1, t("steps.one"),
        step1 ? t("steps.oneDone", { count: state.components }) + (state.statutory ? ` ${t("steps.statutoryOn")}` : ` ${t("steps.statutoryOff")}`) : t("steps.oneTodo"),
        canSettings ? { label: t("steps.oneAction"), to: "/payroll/settings" } : null)}
      {row(step2, step1 && !step2, 2, t("steps.two"),
        canProfiles ? (step2 ? t("steps.twoDone", { done: state.withProfile, total: state.people }) : t("steps.twoTodo")) : t("steps.twoNoAccess"),
        canProfiles ? { label: t("steps.twoAction"), to: "/payroll/profiles" } : null)}
      {row(step3, false, 3, t("steps.three"), t("steps.threeText"), null)}
    </Card>
  );
}
