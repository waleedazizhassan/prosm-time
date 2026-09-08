import { createContext, useContext, useMemo, type ReactNode } from "react";

import { CALENDAR_STORAGE_KEY, DEFAULT_CALENDAR_SYSTEM, readStoredCalendarSystem, type CalendarSystem } from "../utils/formatDate";

// PROSM Time - § user-directed: a real Hijri/Gregorian calendar
// choice for every date shown in the app, mirroring ThemeContext's own
// "per-device, localStorage-backed, System is not an option here since
// there's no OS-level Hijri preference to read" shape. Deliberately a
// per-device display preference (like theme/language), not a per-
// organization setting - the same person may reasonably want one
// calendar on a personal phone and another on a shared kiosk device.
//
// Unlike theme/language, there is no single React re-render mechanism
// every one of the ~60 formatDateOnly/formatDateTime call sites across
// 21 files already subscribes to (language switches piggyback on
// react-i18next's own languageChanged event, which nearly every screen
// already listens to via useTranslation() for its own text - dates
// happen to re-render for free alongside it). Retrofitting the same
// live reactivity for every existing call site was assessed as a real
// correctness risk (silently-stale dates in some screen, hard to catch
// in review) for a preference that is set once and rarely touched
// again - so setCalendarSystem here reloads the app after persisting
// the choice, which guarantees every date on every screen (including
// PDFs, which read the preference fresh at export time regardless)
// reflects the new calendar correctly, at the cost of a one-time
// reload instead of the live swap theme/language get.
export function setCalendarSystem(system: CalendarSystem): void {
  try {
    window.localStorage.setItem(CALENDAR_STORAGE_KEY, system);
  } catch {
    // Storage can be unavailable (private mode, disabled site data) -
    // the reload below still applies the in-memory value for this
    // session even if it won't survive a future reload.
  }
  window.location.reload();
}

interface CalendarContextValue {
  calendarSystem: CalendarSystem;
}

const CalendarContext = createContext<CalendarContextValue | undefined>(undefined);

export function CalendarProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => ({ calendarSystem: readStoredCalendarSystem() }), []);
  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>;
}

export function useCalendar(): CalendarContextValue {
  const context = useContext(CalendarContext);
  if (!context) {
    throw new Error("useCalendar must be used within a CalendarProvider");
  }
  return context;
}

export { DEFAULT_CALENDAR_SYSTEM };
export type { CalendarSystem };
