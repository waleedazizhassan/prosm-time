// Owner 2026-11-03: every email, and the PDF it carries, in the reader's language - one of
// the app's nine. The texts are the app's own (src/i18n/locales/*/emails.json, generated
// into emailTexts.ts), with the same plural rules as the app (i18next suffixes).
import { EMAIL_TEXTS } from "./emailTexts.ts";

export const EMAIL_LANGUAGES = Object.keys(EMAIL_TEXTS);

export function emailLanguage(language: unknown): string {
  const code = typeof language === "string" ? language.slice(0, 2).toLowerCase() : "";
  return EMAIL_LANGUAGES.includes(code) ? code : "en";
}

export const isRtl = (language: string) => language === "ar";

const LOCALES: Record<string, string> = { ar: "ar-EG", en: "en-GB", fr: "fr-FR", de: "de-DE", it: "it-IT", es: "es-ES", pt: "pt-BR", zh: "zh-CN", ru: "ru-RU" };
export const emailLocale = (language: string) => LOCALES[language] ?? "en-GB";

function at(language: string, path: string): unknown {
  let node: unknown = EMAIL_TEXTS[language];
  for (const part of path.split(".")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  return node;
}

function fill(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""));
}

/** A text in the language, plural by vars.count like i18next, else English, else the path. */
export function emailT(language: string, path: string, vars: Record<string, unknown> = {}): string {
  for (const lang of [language, "en"]) {
    if (typeof vars.count === "number") {
      const count = vars.count as number;
      const forms = [count === 0 ? "zero" : null, new Intl.PluralRules(lang).select(count), "other"].filter(Boolean) as string[];
      for (const form of forms) {
        const text = at(lang, `${path}_${form}`);
        if (typeof text === "string") return fill(text, vars);
      }
    }
    const text = at(lang, path);
    if (typeof text === "string") return fill(text, vars);
  }
  return path;
}

/** A leave type, a role, a status...: in a sentence, lower-case where the language writes it so. */
export function inSentence(language: string, label: string): string {
  return ["en", "fr", "es", "pt", "it", "ru"].includes(language) ? label.charAt(0).toLocaleLowerCase(emailLocale(language)) + label.slice(1) : label;
}
