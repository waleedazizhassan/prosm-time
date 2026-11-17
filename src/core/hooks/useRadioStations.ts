import { useEffect, useRef, useState } from "react";
import RadioBrowserClient, { type RadioStation } from "../services/RadioBrowserClient";
import { radioCountry, radioNeighbour } from "../services/radioRegion";

const CACHE_KEY = "prosm_time_radio_stations_v3";
// Owner 2026-11-17: Egyptian stations first - the Holy Quran from Cairo, then the most listened Egyptian stations
// that stream directly (https). Maspero's General Programme / Middle East / Sawt El Qahira stream only inside
// Dailymotion video players, so they cannot play here.
const PINNED = [
  "f62577e7-24e6-416d-a262-033545e41b44", // إذاعة القرآن الكريم من القاهرة
  "006d7922-ffce-4c74-85ab-55ff2ed60fcc", // Radio 9090
  "047fcfb5-9e59-478e-9e6a-a006cc401868", // Nogoum FM
  "b1d17829-6522-481b-bb5c-839c3fd44353", // Radio Hits 88.2 Cairo
  "b8305209-741d-4cd4-8a6d-fac3a5f43e1b", // Mix FM 87.8
  "9346c66b-f42a-4a06-865d-e96dc44b1aa3", // Sha3by FM
  "79282606-a5a9-467b-88dc-7a63fc642f80", // On Sport FM
];
const CACHE_MS = 24 * 60 * 60 * 1000;

function readCache(): RadioStation[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { at: number; country: string | null; stations: RadioStation[] };
    // a new day, or the device moved to another country: fetch again
    if (Date.now() - cached.at > CACHE_MS || cached.country !== radioCountry()) return null;
    return Array.isArray(cached.stations) && cached.stations.length > 0 ? cached.stations : null;
  } catch {
    return null;
  }
}

function writeCache(stations: RadioStation[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), country: radioCountry(), stations }));
  } catch {
    // storage unavailable: the list is fetched again next time
  }
}

// PROSM Time - station search/default-list data logic shared by
// HeaderRadio (desktop, a floating popup) and SidebarRadio (mobile, an
// inline "Media" section - § live UX review, user-directed: "on
// mobile, take the radio out of the header entirely and put it in the
// sidebar under a Media heading"). Both need the identical station
// data - only their layout differs - so this one hook is the single
// source of truth rather than duplicating the fetch/search logic.
export default function useRadioStations(active: boolean) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RadioStation[]>([]);
  const [defaultStations, setDefaultStations] = useState<RadioStation[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadedDefaults, setLoadedDefaults] = useState(false);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active || loadedDefaults) return;
    setLoadedDefaults(true);
    // Owner 2026-10-27 ("lighter, and by where the app is used"): the
    // stations of the device's own country (its time zone), then a few from
    // a neighbour, then the world's most played - one or two requests
    // instead of four, kept for a day so the list opens at once.
    const cached = readCache();
    if (cached) {
      setDefaultStations(cached);
      return;
    }
    const country = radioCountry();
    const neighbour = radioNeighbour(country);
    Promise.allSettled([
      RadioBrowserClient.listByUuids(PINNED).catch(() => [] as RadioStation[]),
      country ? RadioBrowserClient.listByCountryCode(country, 20) : Promise.resolve([] as RadioStation[]),
      neighbour ? RadioBrowserClient.listByCountryCode(neighbour, 6) : Promise.resolve([] as RadioStation[]),
    ])
      .then(async ([pinned, own, near]) => {
        const merged = new Map<string, RadioStation>();
        for (const settled of [pinned, own, near]) {
          if (settled.status !== "fulfilled") continue;
          for (const station of settled.value) if (!merged.has(station.stationUuid)) merged.set(station.stationUuid, station);
        }
        // a thin local catalogue (or no country) is topped up from the world list
        if (merged.size < 12) {
          const top = await RadioBrowserClient.listTopStations(16).catch(() => [] as RadioStation[]);
          for (const station of top) if (!merged.has(station.stationUuid)) merged.set(station.stationUuid, station);
        }
        const list = [...merged.values()];
        setDefaultStations(list);
        if (list.length > 0) writeCache(list);
      })
      .catch(() => setDefaultStations([]));
  }, [active, loadedDefaults]);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      const stations = await RadioBrowserClient.search(query, 30).catch(() => []);
      setResults(stations);
      setSearching(false);
    }, 400);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [query]);

  const stationList = query.trim() ? results : defaultStations;

  return { query, setQuery, stationList, searching };
}
