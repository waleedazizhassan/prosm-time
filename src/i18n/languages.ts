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

// Audit 4.2 (owner 2026-10-12, replacing the earlier "always English on a
// fresh install") - the language the app opens in: the person's own
// choice in the app when there is one, otherwise the device's or
// browser's language when it is supported ("ar-EG" -> "ar"), otherwise English.
export function initialLanguage(saved: string | null, deviceLanguages: readonly string[]): string {
  if (saved && LANGUAGE_CODES.includes(saved)) return saved;
  for (const tag of deviceLanguages) {
    const code = tag.toLowerCase().split("-")[0];
    if (LANGUAGE_CODES.includes(code)) return code;
  }
  return DEFAULT_LANGUAGE;
}

export function getLanguage(code: string): Language {
  return LANGUAGES.find((language) => language.code === code) ?? LANGUAGES[0];
}

export function getDirection(code: string): "ltr" | "rtl" {
  return getLanguage(code).dir;
}

export function getLocale(code: string): string {
  return getLanguage(code).locale;
}
