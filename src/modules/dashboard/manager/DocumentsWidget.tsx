import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { FileCheck } from "lucide-react";

import DocumentsRepository, { type DocumentsOverview } from "../../../core/repositories/DocumentsRepository";
import EmptyState from "../../../components/common/EmptyState";
import styles from "./ManagerDashboard.module.css";

// HR suite feature 2: the documents on the dashboard - the same numbers as the documents page (one server
// read), each opening that page.
export default function DocumentsWidget({ refreshKey }: { refreshKey: string }) {
  const { t } = useTranslation("documents");
  const navigate = useNavigate();
  const [data, setData] = useState<DocumentsOverview | null>(null);

  useEffect(() => {
    void DocumentsRepository.overview().then((r) => setData(r.data));
  }, [refreshKey]);

  const items = data ? ([
    ["expired", data.expired],
    ["expiring", data.expiring],
    ["missing", data.missing],
    ["pendingReview", data.pendingReview],
  ] as const) : [];
  const nothing = items.every(([, n]) => n === 0);

  return (
    <>
      <div className={styles.widgetHeader}>
        <h2 className={styles.widgetTitle}>
          <FileCheck size={16} aria-hidden="true" style={{ verticalAlign: "-2px", marginInlineEnd: 6 }} />
          {t("widget.title")}
        </h2>
        <button type="button" className={styles.chip} onClick={() => navigate("/documents")}>{t("widget.open")}</button>
      </div>
      {/* Owner 2026-11-12: full width like the attendance indicators - no documents says so (not "all good"),
          and what needs action is named: who, which document, how many days are left */}
      <div className={styles.widgetBody}>
        {!data ? <div className={styles.skeleton} style={{ height: 60 }} /> : data.all.length === 0 ? (
          <EmptyState kind="empty" message={t("widget.noDocuments")} />
        ) : nothing ? (
          <EmptyState kind="empty" message={t("widget.allGood", { percent: data.completePercent })} />
        ) : (
          <div className={styles.insights}>
            {items.map(([key, n]) => (
              <button key={key} type="button" className={styles.insightTile} onClick={() => navigate("/documents")} style={{ cursor: "pointer", textAlign: "start", font: "inherit", color: "inherit" }}>
                <span className={styles.kpiLabel}>{t(`tiles.${key}`)}</span>
                <strong style={{ fontSize: "var(--font-xl)", color: n > 0 && key !== "pendingReview" ? "var(--status-danger-text)" : "var(--text-primary)" }}>{n}</strong>
              </button>
            ))}
            {data.action.length > 0 ? (
              <div className={styles.insightTile} style={{ gridColumn: "1 / -1" }}>
                <ul className={styles.rowList}>
                  {data.action.slice(0, 6).map((row) => (
                    <li key={row.id} style={{ cursor: "pointer" }} onClick={() => navigate("/documents")}>
                      <span className={styles.rowMain}>
                        <span className={styles.rowName}>{row.name}</span>
                        <span className={styles.rowMeta}>{[row.typeName, row.site].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className={row.status === "expired" || (row.daysLeft ?? 1) < 0 ? styles.statusBad : styles.statusWarn}>
                        {row.daysLeft != null && row.daysLeft >= 0 ? t("widget.daysLeft", { count: row.daysLeft }) : t(`tiles.${row.status === "pending_review" ? "pendingReview" : row.status === "expired" ? "expired" : row.status === "missing" ? "missing" : "expiring"}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <span className={styles.rowMeta} style={{ gridColumn: "1 / -1" }}>{t("completeLine", { percent: data.completePercent })}</span>
          </div>
        )}
      </div>
    </>
  );
}
