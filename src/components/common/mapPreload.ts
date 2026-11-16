// The base map's styles (OpenFreeMap: free, no key, no limit) and an early, background warm-up of MapLibre - the map
// was slow to appear because everything started only when the map opened (owner 2026-11-16). Kept apart from
// mapBase so the app shell does not pull Leaflet into the first download.
export const MAP_STYLE = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
} as const;

let warm: Promise<unknown> | null = null;
export function preloadBaseMap(): void {
  if (warm || typeof window === "undefined") return;
  warm = Promise.all([
    import("maplibre-gl"),
    fetch(MAP_STYLE.light).catch(() => null),
    fetch(MAP_STYLE.dark).catch(() => null),
  ]).catch(() => null);
}
