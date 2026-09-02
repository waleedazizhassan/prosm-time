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

import enSites from "./locales/en/sites.json";
import arSites from "./locales/ar/sites.json";
import frSites from "./locales/fr/sites.json";
import deSites from "./locales/de/sites.json";
import itSites from "./locales/it/sites.json";

import enManager from "./locales/en/manager.json";
import arManager from "./locales/ar/manager.json";
import frManager from "./locales/fr/manager.json";
import deManager from "./locales/de/manager.json";
import itManager from "./locales/it/manager.json";

import enAttendanceLog from "./locales/en/attendanceLog.json";
import arAttendanceLog from "./locales/ar/attendanceLog.json";
import frAttendanceLog from "./locales/fr/attendanceLog.json";
import deAttendanceLog from "./locales/de/attendanceLog.json";
import itAttendanceLog from "./locales/it/attendanceLog.json";

import enTimesheets from "./locales/en/timesheets.json";
import arTimesheets from "./locales/ar/timesheets.json";
import frTimesheets from "./locales/fr/timesheets.json";
import deTimesheets from "./locales/de/timesheets.json";
import itTimesheets from "./locales/it/timesheets.json";

import enKiosk from "./locales/en/kiosk.json";
import arKiosk from "./locales/ar/kiosk.json";
import frKiosk from "./locales/fr/kiosk.json";
import deKiosk from "./locales/de/kiosk.json";
import itKiosk from "./locales/it/kiosk.json";

import enHelp from "./locales/en/help.json";
import arHelp from "./locales/ar/help.json";
import frHelp from "./locales/fr/help.json";
import deHelp from "./locales/de/help.json";
import itHelp from "./locales/it/help.json";

import enCamera from "./locales/en/camera.json";
import arCamera from "./locales/ar/camera.json";
import frCamera from "./locales/fr/camera.json";
import deCamera from "./locales/de/camera.json";
import itCamera from "./locales/it/camera.json";

// PROSM Time i18n bootstrap. One namespace per screen/domain area,
// exactly the way PROSM Platform's own src/i18n/index.js does - never
// raw strings in components. `shell` is the application shell's own
// namespace (Header/Sidebar/User Menu chrome), matching PROSM
// Platform's own dedicated `sidebar` namespace pattern - never mixed
// into a page's own namespace. `sites` is WP-05's addition (Site
// Management + Map/Geofence, Project Management, §13/§14).

const resources = {
  en: { common: enCommon, auth: enAuth, dashboard: enDashboard, people: enPeople, shell: enShell, sites: enSites, manager: enManager, attendanceLog: enAttendanceLog, timesheets: enTimesheets, kiosk: enKiosk, help: enHelp, camera: enCamera },
  ar: { common: arCommon, auth: arAuth, dashboard: arDashboard, people: arPeople, shell: arShell, sites: arSites, manager: arManager, attendanceLog: arAttendanceLog, timesheets: arTimesheets, kiosk: arKiosk, help: arHelp, camera: arCamera },
  fr: { common: frCommon, auth: frAuth, dashboard: frDashboard, people: frPeople, shell: frShell, sites: frSites, manager: frManager, attendanceLog: frAttendanceLog, timesheets: frTimesheets, kiosk: frKiosk, help: frHelp, camera: frCamera },
  de: { common: deCommon, auth: deAuth, dashboard: deDashboard, people: dePeople, shell: deShell, sites: deSites, manager: deManager, attendanceLog: deAttendanceLog, timesheets: deTimesheets, kiosk: deKiosk, help: deHelp, camera: deCamera },
  it: { common: itCommon, auth: itAuth, dashboard: itDashboard, people: itPeople, shell: itShell, sites: itSites, manager: itManager, attendanceLog: itAttendanceLog, timesheets: itTimesheets, kiosk: itKiosk, help: itHelp, camera: itCamera },
};

export const I18N_STORAGE_KEY = "prosm_time_language";

i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,

    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: LANGUAGE_CODES,

    ns: ["common", "auth", "dashboard", "people", "shell", "sites", "manager", "attendanceLog", "timesheets", "kiosk", "help", "camera"],
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
