import { useEffect, useRef, useState } from "react";
import RadioBrowserClient, { type RadioStation } from "../services/RadioBrowserClient";

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
    // § live UX review, user-directed - "widen the radio's range, add
    // Egyptian/Arab stations" - the global top-clicked list alone
    // rarely surfaces them. Egypt/Arab countries are fetched alongside
    // the global list and placed first, de-duplicated by stationUuid.
    Promise.allSettled([
      RadioBrowserClient.listByCountry("Egypt", 15),
      RadioBrowserClient.listByCountry("Saudi Arabia", 10),
      RadioBrowserClient.listByCountry("United Arab Emirates", 10),
      RadioBrowserClient.listTopStations(24),
    ])
      .then(([egypt, saudi, uae, top]) => {
        const merged = new Map<string, RadioStation>();
        for (const settled of [egypt, saudi, uae, top]) {
          if (settled.status !== "fulfilled") continue;
          for (const station of settled.value) {
            if (!merged.has(station.stationUuid)) merged.set(station.stationUuid, station);
          }
        }
        setDefaultStations([...merged.values()]);
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
