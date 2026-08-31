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

// PROSM Time i18n bootstrap - WP-01 foundation only (the `common`
// namespace). Every future work package adds its own namespace here
// exactly the way PROSM Platform's own src/i18n/index.js does - one
// namespace per screen/domain area, never raw strings in components.

const resources = {
  en: { common: enCommon },
  ar: { common: arCommon },
  fr: { common: frCommon },
  de: { common: deCommon },
  it: { common: itCommon },
};

export const I18N_STORAGE_KEY = "prosm_time_language";

i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,

    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: LANGUAGE_CODES,

    ns: ["common"],
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
