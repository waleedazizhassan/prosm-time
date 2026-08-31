import type { ChangeEvent } from "react";
import FormField from "./FormField";
import styles from "./Input.module.css";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  label?: string;
  name: string;
  value: string;
  options: SelectOption[];
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  required?: boolean;
  disabled?: boolean;
}

export default function Select({ label, name, value, options, onChange, required = false, disabled = false }: SelectProps) {
  return (
    <FormField label={label} htmlFor={name} required={required}>
      <select id={name} name={name} value={value} onChange={onChange} disabled={disabled} className={styles.input}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FormField>
  );
}
