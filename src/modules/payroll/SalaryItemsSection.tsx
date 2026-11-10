import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import type { PayrollComponent } from "../../core/repositories/PayrollCycleRepository";
import Button from "../../components/common/Button";
import { money, parseAmount } from "./payrollUi";
import styles from "./SalaryItemsSection.module.css";

export interface ItemValue {
  amount: string;
  percent: string;
  from: string;
}

// Owner 2026-11-10 ("in the employee's salary card the earnings and the deductions together, not each
// in a different place"): one section per side - earnings (basic first, then raises and allowances)
// and deductions - each with its own "+ new item" that creates the item already on the right side.
export default function SalaryItemsSection({
  kind,
  items,
  values,
  onChange,
  onAdd,
  adding,
  label,
}: {
  kind: "earnings" | "deductions";
  items: PayrollComponent[];
  values: Record<string, ItemValue>;
  onChange: (id: string, value: ItemValue) => void;
  onAdd: (name: string, amount: string) => Promise<boolean>;
  adding: boolean;
  label: (c: PayrollComponent) => string;
}) {
  const { t } = useTranslation("payroll");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");

  const total = items.reduce((sum, c) => {
    if (c.calc_type === "percent") return sum;
    const v = parseAmount(values[c.id]?.amount ?? "");
    return sum + (v && !Number.isNaN(v) ? v : 0);
  }, 0);

  const submit = async () => {
    if (!name.trim()) return;
    if (await onAdd(name.trim(), amount)) {
      setName("");
      setAmount("");
      setOpen(false);
    }
  };

  return (
    <section className={`${styles.section} ${kind === "earnings" ? styles.earnings : styles.deductions}`}>
      <header className={styles.head}>
        <h4>{t(`profiles.${kind}Title`)}</h4>
        <span className={styles.total}>{money(total)}</span>
      </header>
      {items.length === 0 ? <p className={styles.empty}>{t(`profiles.${kind}Empty`)}</p> : null}
      <ul className={styles.rows}>
        {items.map((c) => {
          const value = values[c.id] ?? { amount: "", percent: "", from: "" };
          const isPercent = c.calc_type === "percent";
          return (
            <li key={c.id}>
              <label htmlFor={`item-${c.id}`}>
                {label(c)}
                {c.is_basic ? <small> · {t("profiles.basicTag")}</small> : null}
                {c.category === "allowance" ? <small> · {t("categories.allowance")}</small> : null}
              </label>
              <span className={styles.inputWrap}>
                <input
                  id={`item-${c.id}`}
                  inputMode="decimal"
                  value={isPercent ? value.percent : value.amount}
                  placeholder={c.applies_to_all && c.default_amount != null ? String(c.default_amount) : "0"}
                  onChange={(event) => onChange(c.id, isPercent ? { ...value, percent: event.target.value } : { ...value, amount: event.target.value })}
                />
                {isPercent ? <span className={styles.unit}>%</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {open ? (
        <div className={styles.addRow}>
          <input aria-label={t("profiles.newItemName")} placeholder={t("profiles.newItemName")} value={name} onChange={(event) => setName(event.target.value)} />
          <input aria-label={t("profiles.newItemAmount")} placeholder={t("profiles.newItemAmount")} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
          <Button size="sm" loading={adding} disabled={!name.trim()} onClick={() => void submit()}>{t("profiles.newItemAdd")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t("common:actions.cancel")}</Button>
        </div>
      ) : (
        <button type="button" className={styles.addButton} onClick={() => setOpen(true)}>
          <Plus size={14} /> {t(`profiles.${kind}Add`)}
        </button>
      )}
    </section>
  );
}
