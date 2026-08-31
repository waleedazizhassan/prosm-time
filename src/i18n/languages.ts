// PROSM Time Implementation Master File V3.0, §27: "PROSM Time must
// support: Arabic, English, French, German, Italian." Single source of
// truth for the supported-language list - mirrors PROSM Platform's own
// src/i18n/languages.js shape (shared domain convention, WP-01).
export interface Language {
  code: string;
  label: string;
  nativeLabel: string;
  dir: "ltr" | "rtl";
  locale: string;
}

export const LANGUAGES: Language[] = [
  { code: "en", label: "English", nativeLabel: "English", dir: "ltr", locale: "en-US" },
  { code: "ar", label: "Arabic", nativeLabel: "العربية", dir: "rtl", locale: "ar-SA" },
  { code: "fr", label: "French", nativeLabel: "Français", dir: "ltr", locale: "fr-FR" },
  { code: "de", label: "German", nativeLabel: "Deutsch", dir: "ltr", locale: "de-DE" },
  { code: "it", label: "Italian", nativeLabel: "Italiano", dir: "ltr", locale: "it-IT" },
];

export const DEFAULT_LANGUAGE = "en";

export const LANGUAGE_CODES = LANGUAGES.map((language) => language.code);

export function getLanguage(code: string): Language {
  return LANGUAGES.find((language) => language.code === code) ?? LANGUAGES[0];
}

export function getDirection(code: string): "ltr" | "rtl" {
  return getLanguage(code).dir;
}

export function getLocale(code: string): string {
  return getLanguage(code).locale;
}
