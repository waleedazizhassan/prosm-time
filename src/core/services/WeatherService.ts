const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
// Open-Meteo's geocoding API is forward (name -> coordinates) only.
// BigDataCloud's client-specific reverse-geocode endpoint is a free,
// keyless, CORS-enabled reverse lookup (coordinates -> place name)
// built specifically for browser-side calls like this one. Ported
// from PROSM Platform's own WeatherService (§ visual consistency pass,
// item 5) - both endpoints are free/keyless/CORS-enabled, no backend
// dependency, so this is a genuinely reusable client-only pattern
// rather than Platform-owned infrastructure.
const REVERSE_GEOCODE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

const CACHE_KEY = "prosm_time_weather_cache";
const CACHE_TTL_MS = 30 * 60 * 1000;

export type WeatherCategory =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "thunderstorm"
  | "unknown";

export interface WeatherData {
  cityName: string | null;
  country: string | null;
  temperature: number | null;
  feelsLike: number | null;
  humidity: number | null;
  weatherCode: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  tempMax: number | null;
  tempMin: number | null;
  uvIndex: number | null;
  sunrise: string | null;
  sunset: string | null;
  fetchedAt: string;
}

type WeatherResult = { success: true; data: WeatherData; fromCache: boolean } | { success: false; message: string };

export function weatherCategory(code: number | null): WeatherCategory {
  if (code === null) return "unknown";
  if (code === 0) return "clear";
  if (code === 1 || code === 2) return "partly-cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([95, 96, 99].includes(code)) return "thunderstorm";
  return "unknown";
}

export function windDirectionLabel(degrees: number | null): string {
  if (degrees === null || degrees === undefined) return "—";

  const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const index = Math.round(degrees / 22.5) % 16;
  return directions[index];
}

function readCache(cacheKey: string): WeatherData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    const cache = JSON.parse(raw);
    if (cache.key !== cacheKey) return null;
    if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) return null;

    return cache.data;
  } catch {
    return null;
  }
}

// § user-reported real perf issue (#11, 2026-09-15) - "Weather...
// very slow to load." Second root cause beyond the GPS-accuracy fix
// above: getWeatherForCoordinates's own cache lookup needs real
// coordinates to even COMPUTE its cache key, so a geolocation round
// trip always had to finish first before ANY cached data - even data
// for the exact same real location as last time - could show. Same
// "hydrate from cache immediately, refresh in the background" fix
// already proven for AuthContext.tsx's own profile-load bug
// (2026-09-13): this ignores the coordinate-match requirement
// entirely and returns whatever real weather data was last fetched,
// as long as it's still within the normal TTL - the caller still
// kicks off a real, fresh geolocation+fetch afterward to correct it
// if the viewer has genuinely moved.
export function getLastKnownWeather(): WeatherData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    const cache = JSON.parse(raw);
    if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) return null;

    return cache.data ?? null;
  } catch {
    return null;
  }
}

function writeCache(cacheKey: string, data: WeatherData): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ key: cacheKey, fetchedAt: Date.now(), data }));
  } catch {
    // Cache is a pure optimization - a write failure should never
    // surface as a weather-widget error.
  }
}

async function fetchForecast(latitude: number, longitude: number, cacheKey: string, cityName: string | null, country: string | null): Promise<WeatherResult> {
  try {
    const forecastParams = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      current: ["temperature_2m", "relative_humidity_2m", "apparent_temperature", "weather_code", "wind_speed_10m", "wind_direction_10m"].join(","),
      daily: ["temperature_2m_max", "temperature_2m_min", "uv_index_max", "sunrise", "sunset"].join(","),
      timezone: "auto",
      forecast_days: "1",
    });

    const forecastResponse = await fetch(`${FORECAST_URL}?${forecastParams}`);
    if (!forecastResponse.ok) {
      return { success: false, message: "Unable to load weather data." };
    }

    const forecast = await forecastResponse.json();

    const result: WeatherData = {
      cityName,
      country,
      temperature: forecast.current?.temperature_2m ?? null,
      feelsLike: forecast.current?.apparent_temperature ?? null,
      humidity: forecast.current?.relative_humidity_2m ?? null,
      weatherCode: forecast.current?.weather_code ?? null,
      windSpeed: forecast.current?.wind_speed_10m ?? null,
      windDirection: forecast.current?.wind_direction_10m ?? null,
      tempMax: forecast.daily?.temperature_2m_max?.[0] ?? null,
      tempMin: forecast.daily?.temperature_2m_min?.[0] ?? null,
      uvIndex: forecast.daily?.uv_index_max?.[0] ?? null,
      sunrise: forecast.daily?.sunrise?.[0] ?? null,
      sunset: forecast.daily?.sunset?.[0] ?? null,
      fetchedAt: new Date().toISOString(),
    };

    writeCache(cacheKey, result);

    return { success: true, data: result, fromCache: false };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Weather service unavailable." };
  }
}

class WeatherService {
  // The viewer's own browser geolocation, used only when the browser
  // has actually resolved a position - the caller (getCurrentPosition,
  // core/utils/geo.ts) is responsible for requesting it and handling
  // permission denial/timeout. Coordinates are rounded to ~1.1km
  // precision for the cache key so ordinary GPS/Wi-Fi jitter between
  // mounts doesn't cause a cache miss on every load.
  async getWeatherForCoordinates(latitude: number, longitude: number, { forceRefresh = false }: { forceRefresh?: boolean } = {}): Promise<WeatherResult> {
    const cacheKey = `coords:${latitude.toFixed(2)}|${longitude.toFixed(2)}`;

    if (!forceRefresh) {
      const cached = readCache(cacheKey);
      if (cached) {
        return { success: true, data: cached, fromCache: true };
      }
    }

    const reverseGeoResponse = await fetch(`${REVERSE_GEOCODE_URL}?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`).catch(() => null);

    let cityName: string | null = null;
    let country: string | null = null;

    if (reverseGeoResponse?.ok) {
      const place = await reverseGeoResponse.json().catch(() => null);
      cityName = place?.city || place?.locality || place?.principalSubdivision || null;
      country = place?.countryName ?? null;
    }

    return fetchForecast(latitude, longitude, cacheKey, cityName, country);
  }
}

export default new WeatherService();
