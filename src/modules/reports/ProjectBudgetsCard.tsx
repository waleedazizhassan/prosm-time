import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import InsightsRepository, { type ProjectBudget } from "../../core/repositories/InsightsRepository";
import { appLocale } from "../../core/utils/formatDate";
import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import Table from "../../components/common/Table";

// docs/IDEAS.md 7: each project's budget against what its labour has cost so far.
export default function ProjectBudgetsCard() {
  const { t, i18n } = useTranslation("reports");
  const [rows, setRows] = useState<ProjectBudget[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const load = useCallback(() => void InsightsRepository.projectBudgets().then(setRows), []);
  useEffect(load, [load]);

  if (!rows || rows.length === 0) return null;
  const number = (value: number) => value.toLocaleString(appLocale(i18n.language), { maximumFractionDigits: 0 });

  const save = async (row: ProjectBudget) => {
    setError("");
    const text = (drafts[row.projectId] ?? "").trim();
    const amount = text === "" ? null : Number(text);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      setError(t("budgets.invalid"));
      return;
    }
    if (await InsightsRepository.setProjectBudget(row.projectId, amount)) {
      setDrafts((current) => ({ ...current, [row.projectId]: "" }));
      load();
    } else setError(t("budgets.failed"));
  };

  return (
    <Card title={t("budgets.title")} subtitle={t("budgets.subtitle")}>
      <ErrorText>{error}</ErrorText>
      <Table
        grid
        columns={[
          { key: "project", header: t("budgets.project"), render: (row) => `${row.projectName} · ${row.siteName}` },
          { key: "spent", header: t("budgets.spent"), render: (row) => number(row.spent) },
          { key: "budget", header: t("budgets.budget"), render: (row) => (row.budget === null ? "—" : number(row.budget)) },
          {
            key: "used",
            header: t("budgets.used"),
            render: (row) => {
              if (!row.budget) return "—";
              const used = Math.round((row.spent / row.budget) * 100);
              return <span style={{ color: used >= 100 ? "var(--status-danger-text)" : used >= 80 ? "var(--status-warning-text)" : undefined, fontWeight: "var(--font-weight-semibold)" }}>{used}%</span>;
            },
          },
          {
            key: "set",
            header: "",
            render: (row) => (
              <span style={{ display: "inline-flex", gap: "var(--space-1)", alignItems: "center" }}>
                <input
                  aria-label={t("budgets.budget")}
                  inputMode="decimal"
                  value={drafts[row.projectId] ?? ""}
                  placeholder={row.budget === null ? t("budgets.placeholder") : String(row.budget)}
                  onChange={(event) => setDrafts((current) => ({ ...current, [row.projectId]: event.target.value }))}
                  style={{ width: 96, padding: "var(--space-1) var(--space-2)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-light)", background: "transparent", color: "var(--text-primary)" }}
                />
                <Button size="sm" variant="ghost" onClick={() => save(row)} disabled={drafts[row.projectId] === undefined}>
                  {t("budgets.save")}
                </Button>
              </span>
            ),
          },
        ]}
        data={rows}
        getRowId={(row) => row.projectId}
        emptyMessage=""
      />
      {rows.some((row) => row.unpricedHours > 0) ? <p style={{ margin: "var(--space-2) 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("budgets.unpriced")}</p> : null}
    </Card>
  );
}
