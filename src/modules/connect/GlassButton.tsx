import type { ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./GlassButton.module.css";

// PROSM Connect: the round frosted-glass button used across Connect (calls, messages, meetings).
export default function GlassButton({ label, tone = "plain", size = "medium", children, className, ...rest }: {
  label: string;
  tone?: "plain" | "primary" | "danger" | "success";
  size?: "small" | "medium" | "large";
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  const classes = [styles.glass, tone !== "plain" ? styles[tone] : "", size !== "medium" ? styles[size] : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button type="button" aria-label={label} title={label} className={classes} {...rest}>
      {children}
    </button>
  );
}
