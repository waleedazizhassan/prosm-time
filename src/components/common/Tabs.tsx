import { Lock } from "lucide-react";

import styles from "./Tabs.module.css";

export interface TabItem<K extends string> {
  key: K;
  label: string;
  /** Outside the organisation's plan: shown with a lock, still selectable (it explains the plan). */
  locked?: boolean;
  /** A small number after the label (e.g. items needing action). */
  badge?: number;
}

// HR suite (2026-11-11): one tab bar for the pages made of parts (the employee profile first). It
// scrolls sideways on a phone, keeps the chosen tab underlined, and works with the keyboard.
export default function Tabs<K extends string>({ items, active, onChange, label }: { items: TabItem<K>[]; active: K; onChange: (key: K) => void; label: string }) {
  const move = (from: number, step: number) => {
    const next = items[(from + step + items.length) % items.length];
    onChange(next.key);
    window.setTimeout(() => document.getElementById(`tab-${next.key}`)?.focus(), 0);
  };
  return (
    <div className={styles.bar} role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.key}
          id={`tab-${item.key}`}
          type="button"
          role="tab"
          aria-selected={active === item.key}
          tabIndex={active === item.key ? 0 : -1}
          className={active === item.key ? `${styles.tab} ${styles.active}` : styles.tab}
          onClick={() => onChange(item.key)}
          onKeyDown={(event) => {
            const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
            if (event.key === "ArrowRight") move(index, rtl ? -1 : 1);
            if (event.key === "ArrowLeft") move(index, rtl ? 1 : -1);
          }}
        >
          {item.locked ? <Lock size={13} aria-hidden="true" className={styles.lock} /> : null}
          <span>{item.label}</span>
          {item.badge ? <b className={styles.badge}>{item.badge}</b> : null}
        </button>
      ))}
    </div>
  );
}
