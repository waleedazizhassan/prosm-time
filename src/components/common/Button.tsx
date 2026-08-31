import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  children: ReactNode;
  type?: "button" | "submit";
  variant?: "primary" | "ghost";
  loading?: boolean;
  fullWidth?: boolean;
}

export default function Button({
  children,
  type = "button",
  variant = "primary",
  loading = false,
  fullWidth = false,
  disabled,
  style,
  ...rest
}: ButtonProps) {
  const isPrimary = variant === "primary";

  return (
    <button
      type={type}
      disabled={disabled || loading}
      style={{
        width: fullWidth ? "100%" : undefined,
        padding: "10px 16px",
        fontSize: "0.95rem",
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: disabled || loading ? "not-allowed" : "pointer",
        borderRadius: "var(--radius-md)",
        border: isPrimary ? "none" : "1px solid var(--border)",
        background: isPrimary ? "var(--accent)" : "transparent",
        color: isPrimary ? "var(--accent-contrast)" : "var(--text-primary)",
        opacity: disabled || loading ? 0.6 : 1,
        ...style,
      }}
      {...rest}
    >
      {loading ? "…" : children}
    </button>
  );
}
