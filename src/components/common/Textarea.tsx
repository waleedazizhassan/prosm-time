import type { ChangeEvent } from "react";
import FormField from "./FormField";
import styles from "./Input.module.css";

interface TextareaProps {
  label?: string;
  name: string;
  value: string;
  placeholder?: string;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  required?: boolean;
  disabled?: boolean;
  rows?: number;
}

export default function Textarea({ label, name, value, placeholder = "", onChange, required = false, disabled = false, rows = 3 }: TextareaProps) {
  return (
    <FormField label={label} htmlFor={name} required={required}>
      <textarea
        id={name}
        name={name}
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        disabled={disabled}
        rows={rows}
        className={styles.input}
        style={{ height: "auto", padding: "var(--space-3) var(--space-4)", resize: "vertical" }}
      />
    </FormField>
  );
}
