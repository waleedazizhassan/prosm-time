import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { HardHat } from "lucide-react";

import type { DashboardSite } from "../../../core/repositories/DashboardRepository";
import SiteWorkerRepository, { type ExternalWorker } from "../../../core/repositories/SiteWorkerRepository";
import { formatTimeOnly } from "../../../core/utils/formatDate";

import Modal from "../../../components/common/Modal";
import styles from "./ManagerDashboard.module.css";

const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

// v2.3.43 step 17 (item 4, owner 2026-10-25: "the external workers who are
// present and the sites they are at"): external workers on their own card,
// apart from the employees - each site with its count now and today, the
// contractors with theirs, and a contractor's workers here and not here.
// Counts come from the dashboard read (scoped on the server); the names come
// from the external-workers list, shown only for sites in the reader's scope.
export default function ExternalWorkersWidget({ sites, refreshKey }: { sites: DashboardSite[]; refreshKey: string }) {
  const { t, i18n } = useTranslation("dashboard");
  const navigate = useNavigate();
  const [workers, setWorkers] = useState<ExternalWorker[] | null>(null);
  const [contractor, setContractor] = useState<string | null>(null);

  useEffect(() => {
    SiteWorkerRepository.listExternal().then((result) => setWorkers(result.data ?? []));
  }, [refreshKey]);

  const withExternal = useMemo(() => sites.filter((site) => site.external && (site.external.today > 0 || site.external.presentNow > 0)), [sites]);
  const siteNames = useMemo(() => new Set(sites.map((site) => site.name)), [sites]);
  const presentNow = withExternal.reduce((sum, site) => sum + (site.external?.presentNow ?? 0), 0);

  // A contractor's workers: those here now at a site in scope, then the rest (active, not clocked in).
  const contractorWorkers = useMemo(() => {
    if (contractor === null || !workers) return { here: [], notHere: [] };
    const mine = workers.filter((worker) => worker.status === "active" && (worker.contractorName ?? "") === contractor);
    return {
      here: mine.filter((worker) => worker.clockedInAt && worker.currentSiteName && siteNames.has(worker.currentSiteName)),
      notHere: mine.filter((worker) => !worker.clockedInAt),
    };
  }, [contractor, workers, siteNames]);

  return (
    <>
      <div className={styles.widgetHeader}>
        <h2 className={styles.widgetTitle}>
          <HardHat size={16} aria-hidden="true" style={{ verticalAlign: "-2px", marginInlineEnd: 6 }} />
          {t("manager.external.title", { count: presentNow })}
        </h2>
        <button type="button" className={styles.chip} onClick={() => navigate("/workers")}>
          {t("manager.viewAll")}
        </button>
      </div>
      <div className={styles.widgetBody}>
        {withExternal.length === 0 ? (
          <p className={styles.empty}>{t("manager.sites.noExternal")}</p>
        ) : (
          <ul className={styles.rowList}>
            {withExternal.map((site) => {
              const external = site.external!;
              const share = external.today > 0 ? Math.round((external.presentNow / external.today) * 100) : 0;
              return (
                <li key={site.id} style={{ flexWrap: "wrap" }}>
                  <span className={styles.rowMain} style={{ flex: "0 1 18rem" }}>
                    <span className={styles.rowName}>{site.name}</span>
                    <span className={styles.rowMeta}>{t("manager.sites.externalSummary", { present: external.presentNow, today: external.today, hours: hours(external.minutesToday) })}</span>
                    <span className={styles.bar} style={{ marginTop: 4, maxWidth: 220 }}>
                      <span style={{ width: `${share}%` }} />
                    </span>
                  </span>
                  <span style={{ display: "flex", flexWrap: "wrap", gap: 6, marginInlineStart: "auto" }}>
                    {external.contractors.map((item) => (
                      <button key={item.name} type="button" className={styles.chip} onClick={() => setContractor(item.name)}>
                        {item.name || t("manager.sites.noContractor")} <b>{`${item.present}/${item.today}`}</b>
                      </button>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Modal isOpen={contractor !== null} onClose={() => setContractor(null)} title={contractor || t("manager.sites.noContractor")}>
        {!workers ? (
          <div className={styles.skeleton} style={{ height: 120 }} />
        ) : (
          <>
            <h3 className={styles.widgetTitle} style={{ fontSize: "var(--font-sm)" }}>{t("manager.external.here", { count: contractorWorkers.here.length })}</h3>
            {contractorWorkers.here.length === 0 ? (
              <p className={styles.empty}>{t("manager.external.noneHere")}</p>
            ) : (
              <ul className={styles.rowList}>
                {contractorWorkers.here.map((worker) => (
                  <li key={worker.id}>
                    <span className={styles.rowMain}>
                      <span className={styles.rowName}>{worker.fullName}</span>
                      <span className={styles.rowMeta}>{`${worker.currentSiteName} · ${t("manager.present.since", { time: formatTimeOnly(worker.clockedInAt!, i18n.language) })} · #${worker.workerNumber}`}</span>
                    </span>
                    <span className={styles.statusOk}>{t("manager.external.present")}</span>
                  </li>
                ))}
              </ul>
            )}
            <h3 className={styles.widgetTitle} style={{ fontSize: "var(--font-sm)", marginTop: 12 }}>{t("manager.external.notHere", { count: contractorWorkers.notHere.length })}</h3>
            {contractorWorkers.notHere.length === 0 ? (
              <p className={styles.empty}>—</p>
            ) : (
              <ul className={styles.rowList}>
                {contractorWorkers.notHere.map((worker) => (
                  <li key={worker.id}>
                    <span className={styles.rowMain}>
                      <span className={styles.rowName}>{worker.fullName}</span>
                      <span className={styles.rowMeta}>#{worker.workerNumber}</span>
                    </span>
                    <span className={styles.statusWarn}>{t("manager.external.absent")}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
