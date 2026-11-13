import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, FolderClosed, FolderOpen } from "lucide-react";

import styles from "./MonthFolders.module.css";

// Owner 2026-11-13: "a card for every day is very good - but gather each month's cards in a closed folder named
// after the month, so the page does not fill up and grow heavy; a month's data comes only when its folder is
// opened." The latest month opens by itself; the others are drawn only when opened.
export default function MonthFolders<T>({ items, dayOf, children, openLatest = true }: {
  items: T[];
  // the item's day, YYYY-MM-DD or an ISO time
  dayOf: (item: T) => string;
  children: (monthItems: T[]) => ReactNode;
  openLatest?: boolean;
}) {
  const { i18n, t } = useTranslation("common");
  const months = useMemo(() => {
    const byMonth = new Map<string, T[]>();
    for (const item of items) {
      const key = dayOf(item).slice(0, 7);
      byMonth.set(key, [...(byMonth.get(key) ?? []), item]);
    }
    return [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [items, dayOf]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(openLatest && months[0] ? [months[0][0]] : []));
  const label = (key: string) => {
    const [y, m] = key.split("-").map(Number);
    return new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1));
  };
  // one month only: no folder around it
  if (months.length <= 1) return <>{children(items)}</>;
  return (
    <div className={styles.folders}>
      {months.map(([key, monthItems]) => {
        const isOpen = open.has(key);
        return (
          <section key={key} className={isOpen ? `${styles.folder} ${styles.open}` : styles.folder}>
            <button
              type="button"
              className={styles.head}
              aria-expanded={isOpen}
              onClick={() => setOpen((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
            >
              {isOpen ? <FolderOpen size={18} aria-hidden="true" /> : <FolderClosed size={18} aria-hidden="true" />}
              <span className={styles.name}>{label(key)}</span>
              <span className={styles.count}>{t("monthFolders.count", { count: monthItems.length })}</span>
              <ChevronDown size={16} aria-hidden="true" className={styles.chevron} />
            </button>
            {isOpen ? <div className={styles.body}>{children(monthItems)}</div> : null}
          </section>
        );
      })}
    </div>
  );
}
