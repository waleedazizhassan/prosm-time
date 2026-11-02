import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";

import useTrialStatus from "../../modules/activation/useTrialStatus";
import styles from "./InstallationStatusBanner.module.css";

// Plan stage 3.3: the organisation's licence or trial ended. Everything can be read;
// nothing can be changed until it is reopened. Not closable: it explains refusals.
export default function ReadOnlyBanner() {
  const { t } = useTranslation("shell");
  const { status } = useTrialStatus(true);
  if (!status?.readOnly) return null;
  return (
    <div className={`${styles.banner} ${styles.grace}`} role="status">
      <Lock size={16} />
      <span style={{ flex: 1 }}>
        {t("readOnly.banner")}{" "}
        {status.isOwner ? <Link to="/settings">{t("readOnly.reopen")}</Link> : t("readOnly.askOwner")}
      </span>
    </div>
  );
}
