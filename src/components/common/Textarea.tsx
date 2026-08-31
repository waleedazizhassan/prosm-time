import type { ChangeEvent } from "react";
import FormField from "./FormField";

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
        style={{
          width: "100%",
          padding: "10px 12px",
          fontSize: "0.95rem",
          fontFamily: "inherit",
          color: "var(--text-primary)",
          background: "var(--surface-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          outline: "none",
          resize: "vertical",
        }}
      />
    </FormField>
  );
}
