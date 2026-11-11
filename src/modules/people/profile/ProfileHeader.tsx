import { useTranslation } from "react-i18next";

import Avatar from "../../../components/common/Avatar";
import StatusBadge from "../../../components/common/StatusBadge";
import BuzzButton from "../../../components/common/BuzzButton";
import { formatDateOnly } from "../../../core/utils/formatDate";
import type { EmployeeProfile } from "../../../core/repositories/EmployeeProfileRepository";
import styles from "./Profile.module.css";

// HR suite feature 3: the profile's head - who the person is at a glance (photo, name, job, site, code,
// since when, status) and how complete their file is (mandatory documents in place, feature 2).
export default function ProfileHeader({ profile, onBuzz = true }: { profile: EmployeeProfile; onBuzz?: boolean }) {
  const { t, i18n } = useTranslation("people");
  const h = profile.header;
  const status = !h.isActive ? "deactivated" : h.employmentStatus;
  const facts = [
    h.jobTitle,
    h.siteName,
    h.departmentName,
    h.employeeCode ? t("profile.code", { code: h.employeeCode }) : null,
    h.hireDate ? t("profile.since", { date: formatDateOnly(h.hireDate, i18n.language) }) : null,
  ].filter(Boolean);
  const completion = profile.completion ?? null;
  return (
    <section className={styles.header} aria-label={h.fullName}>
      <Avatar name={h.fullName} url={h.avatarUrl} userId={h.id} size="lg" />
      <div className={styles.headerMain}>
        <h1 className={styles.name}>{h.fullName}</h1>
        {h.legalName && h.legalName !== h.fullName ? <p className={styles.legal}>{h.legalName}</p> : null}
        <p className={styles.facts}>{facts.join(" · ") || t(`common:roles.${h.roleKey}`, { defaultValue: h.roleKey })}</p>
      </div>
      <div className={styles.headerSide}>
        <StatusBadge status={status === "active" ? "active" : status === "suspended" ? "suspended" : status === "ended" ? "expired" : "deactivated"}>
          {t(`profile.status.${status}`)}
        </StatusBadge>
        {completion ? (
          <div className={styles.completion} title={t("profile.completionTitle")}>
            <span>{t("profile.completion", { percent: completion.percent })}</span>
            <div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completion.percent}
              aria-label={t("profile.completionTitle")}>
              <span style={{ width: `${completion.percent}%`, background: completion.percent >= 100 ? "var(--status-success-text)" : "#d97706" }} />
            </div>
            {completion.missing > 0 ? <small>{t("profile.missing", { count: completion.missing })}</small> : null}
          </div>
        ) : null}
        {onBuzz && profile.access !== "self" && h.isActive ? <BuzzButton userId={h.id} name={h.fullName} /> : null}
      </div>
    </section>
  );
}
