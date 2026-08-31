import type { ReactNode } from "react";
import styles from "./FormField.module.css";

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
    <div className={styles.container}>
      {label ? (
        <label htmlFor={htmlFor} className={styles.label}>
          {label}
          {required ? <span className={styles.required}>*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? <span className={styles.error}>{error}</span> : helperText ? <span className={styles.helper}>{helperText}</span> : null}
    </div>
  );
}
