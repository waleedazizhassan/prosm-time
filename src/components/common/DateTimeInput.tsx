import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import FormField from "./FormField";
import inputStyles from "./Input.module.css";
import styles from "./DateRange.module.css";

interface DateTimeInputProps {
  label?: string;
  name: string;
  // "YYYY-MM-DDTHH:mm" (as <input type="datetime-local"> gives), or "" for none
  value: string;
  onChange: (value: string) => void;
  helperText?: string;
  disabled?: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const nowTime = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Owner 2026-10-26 ("put the time and the date in two boxes side by side,
// not inside one"): one moment as a date field and a time field. Choosing
// one part first fills the other with today / the current time, so a half
// filled pair never silently means "now".
export default function DateTimeInput({ label, name, value, onChange, helperText, disabled = false }: DateTimeInputProps) {
  const { t } = useTranslation("common");
  const [date, setDate] = useState(value.slice(0, 10));
  const [time, setTime] = useState(value.slice(11, 16));

  useEffect(() => {
    setDate(value.slice(0, 10));
    setTime(value.slice(11, 16));
  }, [value]);

  const update = (nextDate: string, nextTime: string) => {
    if (nextDate && !nextTime) nextTime = nowTime();
    if (nextTime && !nextDate) nextDate = today();
    setDate(nextDate);
    setTime(nextTime);
    onChange(nextDate && nextTime ? `${nextDate}T${nextTime}` : "");
  };

  return (
    <FormField label={label} htmlFor={`${name}Date`} helperText={helperText}>
      <div className={styles.range}>
        <input id={`${name}Date`} name={`${name}Date`} type="date" className={inputStyles.input} value={date} onChange={(event) => update(event.target.value, event.target.value ? time : "")} disabled={disabled} aria-label={t("dateTime.date")} />
        <input id={`${name}Time`} name={`${name}Time`} type="time" className={inputStyles.input} value={time} onChange={(event) => update(event.target.value ? date : "", event.target.value)} disabled={disabled} aria-label={t("dateTime.time")} />
      </div>
    </FormField>
  );
}
