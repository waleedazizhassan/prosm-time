import { useTranslation } from "react-i18next";

import type { MyPayslip } from "../../core/repositories/PayrollCycleRepository";
import { money } from "./payrollUi";

// One way to show a payslip's lines and net - the employee's own view and the manager's preview of a
// request (owner 2026-11-12) are the same picture.
export default function PayslipLines({ payslip }: { payslip: MyPayslip }) {
  const { t, i18n } = useTranslation("payroll");
  const isRtl = i18n.dir() === "rtl";
  return (
    <div>
      {(["earning", "allowance", "deduction", "installment"] as const).map((category) => {
        const lines = payslip.employee.lines.filter((l) => l.category === category);
        if (lines.length === 0) return null;
        return (
          <div key={category} style={{ marginBottom: "var(--space-2)" }}>
            <h4 style={{ margin: "0 0 4px" }}>{t(`categories.${category}`)}</h4>
            {lines.map((l) => (
              <div key={l.id} style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-sm)", padding: "3px 0", borderBottom: "1px solid var(--border-light)" }}>
                <span>{isRtl ? l.name_ar : l.name_en || l.name_ar}</span><span>{money(l.amount)}</span>
              </div>
            ))}
          </div>
        );
      })}
      <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: "var(--font-lg)", marginTop: "var(--space-2)" }}>
        <span>{t("doc.net")}</span><span>{money(payslip.employee.net_salary)} {payslip.employee.currency}</span>
      </div>
    </div>
  );
}
