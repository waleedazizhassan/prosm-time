import { getDirection } from "./languages";

// Single place that turns "current language" into DOM/CSS direction
// state - §27: "RTL layout must be correctly supported for Arabic."
// Nothing else in the app should read/write document.documentElement.dir
// directly (mirrors PROSM Platform's own src/i18n/direction.js).
export function applyDirection(languageCode: string): void {
  if (typeof document === "undefined") {
    return;
  }

  const direction = getDirection(languageCode);

  document.documentElement.dir = direction;
  document.documentElement.lang = languageCode;
  document.documentElement.dataset.direction = direction;
}

export function isRtl(languageCode: string): boolean {
  return getDirection(languageCode) === "rtl";
}
