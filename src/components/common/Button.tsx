import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  children: ReactNode;
  type?: "button" | "submit";
  variant?: "primary" | "ghost" | "danger";
  size?: "xs" | "sm" | "md";
  loading?: boolean;
  fullWidth?: boolean;
}

// PROSM Time - mirrors PROSM Platform's own Button.module.css exactly
// (§ visual consistency pass, user-directed): same variant/size class
// names and values, same disabled/hover/focus-ring behavior.
export default function Button({
  children,
  type = "button",
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = false,
  disabled,
  className,
  ...rest
}: ButtonProps) {
  const classNames = [styles.button, styles[variant], styles[size], fullWidth ? styles.fullWidth : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <button type={type} disabled={disabled || loading} aria-busy={loading} className={classNames} {...rest}>
      {loading ? "…" : children}
    </button>
  );
}
