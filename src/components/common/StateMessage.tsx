import type { ReactNode } from "react";

import styles from "./StateMessage.module.css";

// A friendly full message with a flat illustration (owner 2026-10-13:
// "offline or network problems should have kind messages with fitting
// pictures"). Used by the page-load and error screens.
export default function StateMessage({ illustration, title, body, action }: { illustration: string; title: string; body: string; action?: ReactNode }) {
  return (
    <div role="alert" className={styles.state}>
      <img src={illustration} alt="" className={styles.art} />
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.body}>{body}</p>
      {action}
    </div>
  );
}
