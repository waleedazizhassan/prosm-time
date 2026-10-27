// Owner 2026-10-27 ("the radio is heavy - make it lighter and smarter: by
// where the app is used, Egypt is not America is not Europe"): the country
// the default stations come from, read from the device's own time zone (and
// its language's region as a fallback) - no location permission needed.

// Time zones of countries whose people use the app most, to their country
// codes; a zone not listed falls back to the language's region.
const ZONES: Record<string, string> = {
  "Africa/Cairo": "EG",
  "Asia/Riyadh": "SA",
  "Asia/Dubai": "AE",
  "Asia/Kuwait": "KW",
  "Asia/Qatar": "QA",
  "Asia/Bahrain": "BH",
  "Asia/Muscat": "OM",
  "Asia/Amman": "JO",
  "Asia/Beirut": "LB",
  "Asia/Baghdad": "IQ",
  "Asia/Damascus": "SY",
  "Asia/Jerusalem": "PS",
  "Asia/Gaza": "PS",
  "Asia/Hebron": "PS",
  "Africa/Tripoli": "LY",
  "Africa/Tunis": "TN",
  "Africa/Algiers": "DZ",
  "Africa/Casablanca": "MA",
  "Africa/Khartoum": "SD",
  "Europe/London": "GB",
  "Europe/Paris": "FR",
  "Europe/Berlin": "DE",
  "Europe/Rome": "IT",
  "Europe/Madrid": "ES",
  "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE",
  "Europe/Vienna": "AT",
  "Europe/Zurich": "CH",
  "Europe/Istanbul": "TR",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Los_Angeles": "US",
  "America/Phoenix": "US",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "Australia/Sydney": "AU",
};

// Neighbours whose stations are a natural second choice (a short list, after the country's own).
const NEIGHBOURS: Record<string, string> = {
  EG: "SA",
  SA: "AE",
  AE: "SA",
  KW: "SA",
  QA: "SA",
  BH: "SA",
  OM: "AE",
  JO: "SA",
  LB: "FR",
  IQ: "SA",
  PS: "JO",
  LY: "EG",
  TN: "FR",
  DZ: "FR",
  MA: "FR",
  SD: "EG",
  GB: "US",
  CA: "US",
  AT: "DE",
  CH: "DE",
  BE: "FR",
  NL: "DE",
};

export function radioCountry(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]): string | null {
  if (timeZone && ZONES[timeZone]) return ZONES[timeZone];
  for (const language of languages) {
    const region = language?.split("-")[1];
    if (region && /^[A-Za-z]{2}$/.test(region)) return region.toUpperCase();
  }
  return null;
}

export function radioNeighbour(country: string | null): string | null {
  return country ? (NEIGHBOURS[country] ?? null) : null;
}
