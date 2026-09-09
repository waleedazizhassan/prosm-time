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

import enLicense from "./locales/en/license.json";
import arLicense from "./locales/ar/license.json";
import frLicense from "./locales/fr/license.json";
import deLicense from "./locales/de/license.json";
import itLicense from "./locales/it/license.json";

import enUpdate from "./locales/en/update.json";
import arUpdate from "./locales/ar/update.json";
import frUpdate from "./locales/fr/update.json";
import deUpdate from "./locales/de/update.json";
import itUpdate from "./locales/it/update.json";

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

import enAllowances from "./locales/en/allowances.json";
import arAllowances from "./locales/ar/allowances.json";
import frAllowances from "./locales/fr/allowances.json";
import deAllowances from "./locales/de/allowances.json";
import itAllowances from "./locales/it/allowances.json";

import enLeave from "./locales/en/leave.json";
import arLeave from "./locales/ar/leave.json";
import frLeave from "./locales/fr/leave.json";
import deLeave from "./locales/de/leave.json";
import itLeave from "./locales/it/leave.json";

import enSchedule from "./locales/en/schedule.json";
import arSchedule from "./locales/ar/schedule.json";
import frSchedule from "./locales/fr/schedule.json";
import deSchedule from "./locales/de/schedule.json";
import itSchedule from "./locales/it/schedule.json";

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

import enReports from "./locales/en/reports.json";
import arReports from "./locales/ar/reports.json";
import frReports from "./locales/fr/reports.json";
import deReports from "./locales/de/reports.json";
import itReports from "./locales/it/reports.json";

import enSettings from "./locales/en/settings.json";
import arSettings from "./locales/ar/settings.json";
import frSettings from "./locales/fr/settings.json";
import deSettings from "./locales/de/settings.json";
import itSettings from "./locales/it/settings.json";

import enEmergencyLog from "./locales/en/emergencyLog.json";
import arEmergencyLog from "./locales/ar/emergencyLog.json";
import frEmergencyLog from "./locales/fr/emergencyLog.json";
import deEmergencyLog from "./locales/de/emergencyLog.json";
import itEmergencyLog from "./locales/it/emergencyLog.json";

// PROSM Time i18n bootstrap. One namespace per screen/domain area,
// exactly the way PROSM Platform's own src/i18n/index.js does - never
// raw strings in components. `shell` is the application shell's own
// namespace (Header/Sidebar/User Menu chrome), matching PROSM
// Platform's own dedicated `sidebar` namespace pattern - never mixed
// into a page's own namespace. `sites` is WP-05's addition (Site
// Management + Map/Geofence, Project Management, §13/§14).

const resources = {
  en: { common: enCommon, auth: enAuth, dashboard: enDashboard, people: enPeople, shell: enShell, sites: enSites, manager: enManager, attendanceLog: enAttendanceLog, timesheets: enTimesheets, allowances: enAllowances, leave: enLeave, schedule: enSchedule, kiosk: enKiosk, help: enHelp, camera: enCamera, reports: enReports, settings: enSettings, emergencyLog: enEmergencyLog, license: enLicense, update: enUpdate },
  ar: { common: arCommon, auth: arAuth, dashboard: arDashboard, people: arPeople, shell: arShell, sites: arSites, manager: arManager, attendanceLog: arAttendanceLog, timesheets: arTimesheets, allowances: arAllowances, leave: arLeave, schedule: arSchedule, kiosk: arKiosk, help: arHelp, camera: arCamera, reports: arReports, settings: arSettings, emergencyLog: arEmergencyLog, license: arLicense, update: arUpdate },
  fr: { common: frCommon, auth: frAuth, dashboard: frDashboard, people: frPeople, shell: frShell, sites: frSites, manager: frManager, attendanceLog: frAttendanceLog, timesheets: frTimesheets, allowances: frAllowances, leave: frLeave, schedule: frSchedule, kiosk: frKiosk, help: frHelp, camera: frCamera, reports: frReports, settings: frSettings, emergencyLog: frEmergencyLog, license: frLicense, update: frUpdate },
  de: { common: deCommon, auth: deAuth, dashboard: deDashboard, people: dePeople, shell: deShell, sites: deSites, manager: deManager, attendanceLog: deAttendanceLog, timesheets: deTimesheets, allowances: deAllowances, leave: deLeave, schedule: deSchedule, kiosk: deKiosk, help: deHelp, camera: deCamera, reports: deReports, settings: deSettings, emergencyLog: deEmergencyLog, license: deLicense, update: deUpdate },
  it: { common: itCommon, auth: itAuth, dashboard: itDashboard, people: itPeople, shell: itShell, sites: itSites, manager: itManager, attendanceLog: itAttendanceLog, timesheets: itTimesheets, allowances: itAllowances, leave: itLeave, schedule: itSchedule, kiosk: itKiosk, help: itHelp, camera: itCamera, reports: itReports, settings: itSettings, emergencyLog: itEmergencyLog, license: itLicense, update: itUpdate },
};

export const I18N_STORAGE_KEY = "prosm_time_language";

i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,

    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: LANGUAGE_CODES,

    ns: ["common", "auth", "dashboard", "people", "shell", "sites", "manager", "attendanceLog", "timesheets", "allowances", "leave", "schedule", "kiosk", "help", "camera", "reports", "settings", "emergencyLog"],
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
  });

applyDirection(i18next.language);

i18next.on("languageChanged", (language) => {
  applyDirection(language);
});

export default i18next;
