// PROSM Time - a small shared reverse-geocode helper (coordinates ->
// human-readable place name), reusing the exact same free, keyless,
// CORS-enabled BigDataCloud endpoint WeatherService.ts already calls -
// not a second/different geocoding integration.
//
// § final visual consistency pass - "I want the name of the place
// where clock-in happened to be written... the place should appear in
// a field next to the time counter or below it" (user-directed,
// mobile attendance UX). Display-only, best-effort: a failed/timed-out
// lookup never blocks or affects the attendance action itself, exactly
// like every other geolocation read in this app.
const REVERSE_GEOCODE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

export async function reverseGeocodePlaceName(latitude: number, longitude: number, languageCode: string): Promise<string | null> {
  try {
    const response = await fetch(`${REVERSE_GEOCODE_URL}?latitude=${latitude}&longitude=${longitude}&localityLanguage=${languageCode}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;

    const place = await response.json();
    const locality: string | null = place?.city || place?.locality || place?.principalSubdivision || null;
    const country: string | null = place?.countryName ?? null;

    if (locality && country) return `${locality}, ${country}`;
    return locality ?? country ?? null;
  } catch {
    return null;
  }
}

// Owner 2026-11-13: a new site's address is filled from its position - the district, the city and the
// governorate (e.g. "El Obour, Cairo"), from the same free endpoint. Best-effort: nothing is filled when it fails.
export async function reverseGeocodeAddress(latitude: number, longitude: number, languageCode: string): Promise<string | null> {
  try {
    const response = await fetch(`${REVERSE_GEOCODE_URL}?latitude=${latitude}&longitude=${longitude}&localityLanguage=${languageCode}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const place = await response.json();
    const parts: string[] = [];
    for (const part of [place?.locality, place?.city, place?.principalSubdivision, place?.countryName]) {
      const value = typeof part === "string" ? part.trim() : "";
      if (value && !parts.some((p) => p === value || p.includes(value) || value.includes(p))) parts.push(value);
    }
    return parts.length > 0 ? parts.join(languageCode === "ar" ? "، " : ", ") : null;
  } catch {
    return null;
  }
}
