import type { ChangeEvent } from "react";
import FormField from "./FormField";
import styles from "./Input.module.css";

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
        className={[styles.input, error ? styles.errorInput : ""].filter(Boolean).join(" ")}
      />
    </FormField>
  );
}
