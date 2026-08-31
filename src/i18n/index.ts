import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import { DEFAULT_LANGUAGE, LANGUAGE_CODES } from "./languages";
import { applyDirection } from "./direction";

import enCommon from "./locales/en/common.json";
import arCommon from "./locales/ar/common.json";
import frCommon from "./locales/fr/common.json";
import deCommon from "./locales/de/common.json";
import itCommon from "./locales/it/common.json";

import enAuth from "./locales/en/auth.json";
import arAuth from "./locales/ar/auth.json";
import frAuth from "./locales/fr/auth.json";
import deAuth from "./locales/de/auth.json";
import itAuth from "./locales/it/auth.json";

import enDashboard from "./locales/en/dashboard.json";
import arDashboard from "./locales/ar/dashboard.json";
import frDashboard from "./locales/fr/dashboard.json";
import deDashboard from "./locales/de/dashboard.json";
import itDashboard from "./locales/it/dashboard.json";

import enPeople from "./locales/en/people.json";
import arPeople from "./locales/ar/people.json";
import frPeople from "./locales/fr/people.json";
import dePeople from "./locales/de/people.json";
import itPeople from "./locales/it/people.json";

import enShell from "./locales/en/shell.json";
import arShell from "./locales/ar/shell.json";
import frShell from "./locales/fr/shell.json";
import deShell from "./locales/de/shell.json";
import itShell from "./locales/it/shell.json";

// PROSM Time i18n bootstrap. One namespace per screen/domain area,
// exactly the way PROSM Platform's own src/i18n/index.js does - never
// raw strings in components. `shell` is the application shell's own
// namespace (Header/Sidebar/User Menu chrome), matching PROSM
// Platform's own dedicated `sidebar` namespace pattern - never mixed
// into a page's own namespace.

const resources = {
  en: { common: enCommon, auth: enAuth, dashboard: enDashboard, people: enPeople, shell: enShell },
  ar: { common: arCommon, auth: arAuth, dashboard: arDashboard, people: arPeople, shell: arShell },
  fr: { common: frCommon, auth: frAuth, dashboard: frDashboard, people: frPeople, shell: frShell },
  de: { common: deCommon, auth: deAuth, dashboard: deDashboard, people: dePeople, shell: deShell },
  it: { common: itCommon, auth: itAuth, dashboard: itDashboard, people: itPeople, shell: itShell },
};

export const I18N_STORAGE_KEY = "prosm_time_language";

i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,

    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: LANGUAGE_CODES,

    ns: ["common", "auth", "dashboard", "people", "shell"],
    defaultNS: "common",

    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: I18N_STORAGE_KEY,
      caches: ["localStorage"],
    },

    interpolation: {
      escapeValue: false,
    },

    returnNull: false,
  });

applyDirection(i18next.language);

i18next.on("languageChanged", (language) => {
  applyDirection(language);
});

export default i18next;
