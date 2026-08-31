import styles from "./Toggle.module.css";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}

// PROSM Time - mirrors PROSM Platform's own Toggle component exactly
// (§ visual consistency pass, user-directed): same track/thumb shape,
// same brand-primary checked color, real role="switch" semantics.
export default function Toggle({ checked, onChange, disabled, label }: ToggleProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={[styles.track, checked ? styles.checked : ""].filter(Boolean).join(" ")} onClick={() => onChange(!checked)}>
      <span className={styles.thumb} />
    </button>
  );
}
