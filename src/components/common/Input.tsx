import type { ChangeEvent } from "react";
import FormField from "./FormField";

interface InputProps {
  label?: string;
  name: string;
  type?: string;
  value: string;
  placeholder?: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
  disabled?: boolean;
  helperText?: string;
  error?: string;
  autoComplete?: string;
}

export default function Input({
  label,
  name,
  type = "text",
  value,
  placeholder = "",
  onChange,
  required = false,
  disabled = false,
  helperText = "",
  error = "",
  autoComplete,
}: InputProps) {
  return (
    <FormField label={label} htmlFor={name} required={required} helperText={helperText} error={error}>
      <input
        id={name}
        name={name}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        disabled={disabled}
        autoComplete={autoComplete}
        style={{
          width: "100%",
          padding: "10px 12px",
          fontSize: "0.95rem",
          fontFamily: "inherit",
          color: "var(--text-primary)",
          background: "var(--surface-card)",
          border: `1px solid ${error ? "var(--danger)" : "var(--border)"}`,
          borderRadius: "var(--radius-md)",
          outline: "none",
        }}
      />
    </FormField>
  );
}
