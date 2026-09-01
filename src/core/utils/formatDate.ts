import { getLocale } from "../../i18n/languages";

// PROSM Time WP-19/§27 - "no hard-coded user-facing strings... where
// localization is required." Date/time display is a real localization
// concern too, not just strings - every toLocale*() call in the app
// goes through here so it reflects the CURRENTLY SELECTED language
// (getLocale() -> its real BCP-47 locale), never just the browser's
// own OS-level locale as bare toLocaleString() would.
export function formatDateTime(value: string | Date, languageCode: string): string {
  return new Date(value).toLocaleString(getLocale(languageCode));
}

export function formatDateOnly(value: string | Date, languageCode: string): string {
  return new Date(value).toLocaleDateString(getLocale(languageCode));
}

export function formatTimeOnly(value: string | Date, languageCode: string): string {
  return new Date(value).toLocaleTimeString(getLocale(languageCode));
}
