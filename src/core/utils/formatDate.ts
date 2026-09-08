import { getLocale } from "../../i18n/languages";

// PROSM Time WP-19/§27 - "no hard-coded user-facing strings... where
// localization is required." Date/time display is a real localization
// concern too, not just strings - every toLocale*() call in the app
// goes through here so it reflects the CURRENTLY SELECTED language
// (getLocale() -> its real BCP-47 locale), never just the browser's
// own OS-level locale as bare toLocaleString() would.
//
// § user-directed: a real Hijri/Gregorian calendar choice. Uses the
// browser/Node's own native Intl calendar support (calendar:
// "islamic-umalqura") rather than a bundled conversion library - V8's
// ICU data backs Web, Electron (Chromium) and the Capacitor Android
// WebView (also Chromium) identically, so this is accurate and
// dependency-free across all three PROSM Time builds. The preference
// itself lives in localStorage (CalendarContext.tsx), read here via a
// plain accessor so these functions stay usable from non-React code
// (the PDF export modules) without needing a React context.
export type CalendarSystem = "gregorian" | "hijri";

export const CALENDAR_STORAGE_KEY = "prosm_time_calendar_system";
export const DEFAULT_CALENDAR_SYSTEM: CalendarSystem = "gregorian";

export function readStoredCalendarSystem(): CalendarSystem {
  if (typeof window === "undefined") return DEFAULT_CALENDAR_SYSTEM;
  try {
    return window.localStorage.getItem(CALENDAR_STORAGE_KEY) === "hijri" ? "hijri" : DEFAULT_CALENDAR_SYSTEM;
  } catch {
    return DEFAULT_CALENDAR_SYSTEM;
  }
}

function icuCalendar(system: CalendarSystem): "gregory" | "islamic-umalqura" {
  return system === "hijri" ? "islamic-umalqura" : "gregory";
}

export function formatDateTime(value: string | Date, languageCode: string): string {
  const locale = `${getLocale(languageCode)}-u-ca-${icuCalendar(readStoredCalendarSystem())}`;
  return new Date(value).toLocaleString(locale);
}

export function formatDateOnly(value: string | Date, languageCode: string): string {
  const locale = `${getLocale(languageCode)}-u-ca-${icuCalendar(readStoredCalendarSystem())}`;
  return new Date(value).toLocaleDateString(locale);
}

export function formatTimeOnly(value: string | Date, languageCode: string): string {
  // Time-of-day has no calendar system of its own - always plain
  // Gregorian locale formatting, matching the previous behavior.
  return new Date(value).toLocaleTimeString(getLocale(languageCode));
}
