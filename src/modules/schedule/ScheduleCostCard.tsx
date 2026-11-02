import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import InsightsRepository, { type ScheduleCost } from "../../core/repositories/InsightsRepository";
import { appLocale } from "../../core/utils/formatDate";
import Card from "../../components/common/Card";

// docs/IDEAS.md 2: what the roster on screen will cost, before it is worked. The
// server answers only those allowed to see pay; for anyone else this stays hidden.
export default function ScheduleCostCard({ siteId, startDate, endDate, refreshKey }: { siteId: string; startDate: string; endDate: string; refreshKey: number }) {
  const { t, i18n } = useTranslation("schedule");
  const [cost, setCost] = useState<ScheduleCost | null>(null);

  useEffect(() => {
    if (!siteId || !startDate || !endDate) return;
    void InsightsRepository.scheduleCost(siteId, startDate, endDate).then(setCost);
  }, [siteId, startDate, endDate, refreshKey]);

  if (!cost || cost.shifts === 0) return null;
  const money = (value: number) => `${value.toLocaleString(appLocale(i18n.language), { maximumFractionDigits: 0 })} ${cost.currency ?? ""}`.trim();

  return (
    <Card title={t("cost.title")} subtitle={t("cost.subtitle")}>
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "var(--space-3)", margin: 0 }}>
        <div>
          <dt>{t("cost.regular")}</dt>
          <dd style={{ margin: 0 }}>{t("cost.hours", { hours: cost.regularHours })} · {money(cost.regularCost)}</dd>
        </div>
        <div>
          <dt>{t("cost.overtime")}</dt>
          <dd style={{ margin: 0, color: cost.overtimeHours > 0 ? "var(--status-warning-text)" : undefined }}>
            {t("cost.hours", { hours: cost.overtimeHours })} · {money(cost.overtimeCost)}
          </dd>
        </div>
        <div>
          <dt>{t("cost.total")}</dt>
          <dd style={{ margin: 0, fontWeight: "var(--font-weight-semibold)" }}>{money(cost.regularCost + cost.overtimeCost)}</dd>
        </div>
      </dl>
      {cost.unpricedShifts > 0 ? <p style={{ margin: "var(--space-2) 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("cost.unpriced", { count: cost.unpricedShifts })}</p> : null}
    </Card>
  );
}
