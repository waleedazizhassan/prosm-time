import type { ChangeEvent } from "react";
import Dropdown from "./Dropdown";
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

// Owner 2026-10-26: the list is the app's own (Dropdown), not the browser's;
// callers still get a change event with target.value and target.name.
export default function Select({ label, name, value, options, onChange, required = false, disabled = false }: SelectProps) {
  return (
    <FormField label={label} htmlFor={name} required={required}>
      <Dropdown
        id={name}
        name={name}
        value={value}
        options={options}
        disabled={disabled}
        className={styles.input}
        onChange={(next) => onChange({ target: { value: next, name }, currentTarget: { value: next, name } } as unknown as ChangeEvent<HTMLSelectElement>)}
      />
    </FormField>
  );
}
