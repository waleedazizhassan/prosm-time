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
      <div className={styles.widgetBody}>
        {!data ? <div className={styles.skeleton} style={{ height: 60 }} /> : nothing ? (
          <EmptyState kind="empty" message={t("widget.allGood", { percent: data.completePercent })} />
        ) : (
          <ul className={styles.rowList}>
            {items.filter(([, n]) => n > 0).map(([key, n]) => (
              <li key={key} style={{ cursor: "pointer" }} onClick={() => navigate("/documents")}>
                <span className={styles.rowMain}><span className={styles.rowName}>{t(`tiles.${key}`)}</span></span>
                <strong>{n}</strong>
              </li>
            ))}
            <li><span className={styles.rowMeta}>{t("completeLine", { percent: data.completePercent })}</span></li>
          </ul>
        )}
      </div>
    </>
  );
}
