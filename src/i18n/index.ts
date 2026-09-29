import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import { DEFAULT_LANGUAGE, LANGUAGE_CODES } from "./languages";
import { applyDirection } from "./direction";



















// PROSM Time i18n bootstrap. One namespace per screen/domain area,
// exactly the way PROSM Platform's own src/i18n/index.js does - never
// raw strings in components. `shell` is the application shell's own
// namespace (Header/Sidebar/User Menu chrome), matching PROSM
// Platform's own dedicated `sidebar` namespace pattern - never mixed
// into a page's own namespace. `sites` is WP-05's addition (Site
// Management + Map/Geofence, Project Management, §13/§14).

// Only the reader's language is downloaded (owner 2026-09-29: a light mobile app). A small backend
// loads every namespace of a language before i18next switches to it, so the screen never shows raw
// keys; another language is fetched only if the reader switches. All five languages hold every key.
const BUNDLES = import.meta.glob<{ default: Record<string, unknown> }>("./locales/*/*.json");
const NAMESPACES = Object.keys(BUNDLES)
  .filter((p) => p.startsWith("./locales/en/"))
  .map((p) => p.slice("./locales/en/".length, -".json".length));

const lazyBundles = {
  type: "backend" as const,
  init() {},
  read(language: string, namespace: string, done: (error: unknown, data: Record<string, unknown> | boolean) => void) {
    const load = BUNDLES[`./locales/${language}/${namespace}.json`];
    if (!load) return done(null, {});
    load().then((m) => done(null, m.default), (e) => done(e, false));
  },
};

export const I18N_STORAGE_KEY = "prosm_time_language";

const saved = (() => {
  try {
    return localStorage.getItem(I18N_STORAGE_KEY);
  } catch {
    return null;
  }
})();

/** Resolves when the reader's language is loaded; the app renders after it. */
export const i18nReady = i18next
  .use(lazyBundles)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    lng: saved && (LANGUAGE_CODES as readonly string[]).includes(saved) ? saved : DEFAULT_LANGUAGE,
    // Every language holds every key (checked 2026-09-29), so no second language is loaded as a fallback.
    fallbackLng: false,
    supportedLngs: LANGUAGE_CODES,

    ns: NAMESPACES,
    defaultNS: "common",

    // § live UX review, user-directed - a fresh install must default to
    // English regardless of the device's own OS language; only an
    // explicit in-app choice (persisted to localStorage) should ever
    // override fallbackLng. "navigator" detection deliberately removed.
    detection: {
      order: ["localStorage"],
      lookupLocalStorage: I18N_STORAGE_KEY,
      caches: ["localStorage"],
    },

    interpolation: {
      escapeValue: false,
    },

    returnNull: false,

    react: { useSuspense: false },
  });

applyDirection(i18next.language);

i18next.on("languageChanged", (language) => {
  applyDirection(language);
});

export default i18next;
