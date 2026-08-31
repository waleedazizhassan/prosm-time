import type { ReactNode } from "react";

interface FormFieldProps {
  label?: string;
  htmlFor?: string;
  required?: boolean;
  helperText?: string;
  error?: string;
  children: ReactNode;
}

export default function FormField({ label, htmlFor, required, helperText, error, children }: FormFieldProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", marginBottom: "var(--space-4)" }}>
      {label ? (
        <label htmlFor={htmlFor} style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--text-primary)" }}>
          {label}
          {required ? <span style={{ color: "var(--danger)" }}> *</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <span style={{ fontSize: "0.8rem", color: "var(--danger)" }}>{error}</span>
      ) : helperText ? (
        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>{helperText}</span>
      ) : null}
    </div>
  );
}
