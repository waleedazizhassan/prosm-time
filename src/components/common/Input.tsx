import { useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
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
  readOnly?: boolean;
  helperText?: string;
  error?: string;
  autoComplete?: string;
}

// § live UX review, user-directed - "a show/hide password button on
// every page." Built once here rather than per-page: any caller that
// already passes type="password" gets the toggle automatically, no
// call-site changes needed anywhere it's already used.
export default function Input({
  label,
  name,
  type = "text",
  value,
  placeholder = "",
  onChange,
  required = false,
  disabled = false,
  readOnly = false,
  helperText = "",
  error = "",
  autoComplete,
}: InputProps) {
  const { t } = useTranslation("common");
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === "password";
  const effectiveType = isPassword && revealed ? "text" : type;

  const inputElement = (
    <input
      id={name}
      name={name}
      type={effectiveType}
      value={value}
      placeholder={placeholder}
      onChange={onChange}
      disabled={disabled}
      readOnly={readOnly}
      autoComplete={autoComplete}
      className={[styles.input, error ? styles.errorInput : "", isPassword ? styles.passwordInput : ""].filter(Boolean).join(" ")}
    />
  );

  return (
    <FormField label={label} htmlFor={name} required={required} helperText={helperText} error={error}>
      {isPassword ? (
        <div className={styles.passwordWrapper}>
          {inputElement}
          <button
            type="button"
            className={styles.revealToggle}
            onClick={() => setRevealed((current) => !current)}
            disabled={disabled}
            tabIndex={-1}
            aria-label={revealed ? t("hidePassword") : t("showPassword")}
            title={revealed ? t("hidePassword") : t("showPassword")}
          >
            {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      ) : (
        inputElement
      )}
    </FormField>
  );
}
