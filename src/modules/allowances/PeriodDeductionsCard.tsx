import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import LeaveRepository from "../../core/repositories/LeaveRepository";
import EmployeeRepository from "../../core/repositories/EmployeeRepository";
import { formatDateOnly } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import ListRow from "../../components/common/ListRow";
import HintText from "../../components/common/HintText";

// v2.3.43 step 9 (item 19): the "unpaid leave deduction" lines of the period
// shown with the allowances (each deducted day is its own line, so it lands
// in the right pay period). Only what the reader may see (server-checked).
export default function PeriodDeductionsCard({ from, to }: { from: string; to: string }) {
  const { t, i18n } = useTranslation("allowances");
  const [rows, setRows] = useState<{ userId: string; workDate: string; amount: number; currency: string }[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!from || !to) return;
    LeaveRepository.listPayrollAdjustments(null, from, to).then((result) => setRows(result.data ?? []));
  }, [from, to]);

  useEffect(() => {
    if (rows.length === 0) return;
    EmployeeRepository.listOrganizationMembers().then((result) =>
      setNames(Object.fromEntries((result.data ?? []).map((member) => [member.id, member.fullName]))),
    );
  }, [rows.length]);

  if (rows.length === 0) return null;

  const byPerson = new Map<string, { total: number; currency: string; days: string[] }>();
  for (const row of rows) {
    const current = byPerson.get(row.userId) ?? { total: 0, currency: row.currency, days: [] };
    current.total += row.amount;
    current.days.push(row.workDate);
    byPerson.set(row.userId, current);
  }

  return (
    <Card title={t("deductions.title")}>
      <HintText small>{t("deductions.hint")}</HintText>
      {[...byPerson.entries()].map(([userId, entry]) => (
        <ListRow key={userId}>
          <div>
            <div style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>
              {names[userId] ?? "—"} — {t("deductions.line")}
            </div>
            <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{entry.days.map((day) => formatDateOnly(day, i18n.language)).join("، ")}</div>
          </div>
          <strong style={{ fontVariantNumeric: "tabular-nums", color: "var(--status-danger-text, var(--text-primary))" }}>
            {entry.total.toLocaleString(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {entry.currency}
          </strong>
        </ListRow>
      ))}
    </Card>
  );
}
