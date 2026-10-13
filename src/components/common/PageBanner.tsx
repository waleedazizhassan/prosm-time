import { useTranslation } from "react-i18next";

import styles from "./PageBanner.module.css";

// Page name card (owner 2026-10-13: flat 2D illustrations with people,
// small, never cut). The page's own name (the same as in the sidebar), a
// short line about it, and a flat illustration; about 76 px tall.
export default function PageBanner({ pageId, illustration }: { pageId: string; illustration: string }) {
  const { t } = useTranslation("shell");
  return (
    <div className={styles.banner}>
      <div className={styles.text}>
        <h1 className={styles.title}>{t(`items.${pageId}`)}</h1>
        <p className={styles.subtitle}>{t(`pageBanner.${pageId}`)}</p>
      </div>
      <img src={illustration} alt="" className={styles.art} />
    </div>
  );
}
