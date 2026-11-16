import L from "leaflet";

import { MAP_STYLE as STYLE } from "./mapPreload";

// Owner 2026-11-15: "I don't like the new maps" - the light map was washed out and pink, the dark one loud pink and
// orange. Both were plain OpenStreetMap pictures recoloured with a CSS filter, which can never look clean. Now real
// map styles drawn for each theme: OpenFreeMap (free, no key, no account, no usage limit, commercial use allowed),
// "positron" for light and "dark" for dark, drawn by MapLibre inside the same Leaflet maps.
// MapLibre needs WebGL: on a device without it, the plain OpenStreetMap picture is used as before.
// The credit OpenStreetMap's licence asks for stays, as small see-through plain text (no link) - owner 2026-11-15.
export const MAP_ATTRIBUTION = "© OpenStreetMap";
const FALLBACK_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

let webgl: boolean | null = null;
function hasWebGL(): boolean {
  if (webgl !== null) return webgl;
  try {
    const canvas = document.createElement("canvas");
    webgl = Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    webgl = false;
  }
  return webgl;
}

/** Adds the base map for the theme and returns it (to remove on a theme change). Loads MapLibre only when needed. */
// Place names in the person's language (Arabic names for Arabic, else the local name), not two languages side by
// side; and the dark map leaning to PROSM's navy instead of a neutral grey.
function tune(gl: import("maplibre-gl").Map, dark: boolean, language: string) {
  const name: unknown = ["coalesce", ["get", `name:${language}`], ["get", "name"]];
  for (const layer of gl.getStyle().layers ?? []) {
    if (layer.type === "symbol" && layer.layout && "text-field" in layer.layout) {
      const field = JSON.stringify(layer.layout["text-field"]);
      if (field.includes("name")) gl.setLayoutProperty(layer.id, "text-field", name as never);
    }
  }
  if (!dark) return;
  const paint: Record<string, [string, string]> = {
    background: ["background-color", "#0b1324"],
    water: ["fill-color", "#0d2340"],
    landuse_park: ["fill-color", "#0f1c2c"],
    landcover_wood: ["fill-color", "#0f1c2c"],
    building: ["fill-color", "#0e1a2e"],
  };
  for (const [id, [prop, value]] of Object.entries(paint)) {
    if (gl.getLayer(id)) gl.setPaintProperty(id, prop as never, value as never);
  }
  // roads: black on navy disappeared - muted blue-greys, the big roads a little brighter (the dark style's own ids)
  const roads: Record<string, string> = {
    highway_path: "#16233a",
    highway_minor: "#1a2a45",
    highway_major_casing: "#22395e",
    highway_major_inner: "#1f3253",
    highway_major_subtle: "#1f3253",
    highway_motorway_casing: "#2b4775",
    highway_motorway_inner: "#2a4470",
    highway_motorway_subtle: "#22395e",
    waterway: "#0f2a4a",
    road_pier: "#16233a",
  };
  for (const [id, color] of Object.entries(roads)) {
    if (gl.getLayer(id)) gl.setPaintProperty(id, "line-color", color);
  }
}

export async function addBaseLayer(map: L.Map, dark: boolean, fallbackClassName?: string, alive: () => boolean = () => true, language = "ar"): Promise<L.Layer | null> {
  if (hasWebGL()) {
    try {
      await import("maplibre-gl/dist/maplibre-gl.css");
      const maplibre = await import("maplibre-gl");
      // MapLibre 6 runs its drawing work in a separate worker file; bundled, its own relative path breaks, so it is
      // handed the worker Vite builds (with everything the worker imports)
      const { default: workerUrl } = await import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url");
      maplibre.setWorkerUrl(workerUrl);
      // the Leaflet binding looks for MapLibre on the window when it is bundled
      (window as unknown as { maplibregl?: unknown }).maplibregl = (maplibre as { default?: unknown }).default ?? maplibre;
      await import("@maplibre/maplibre-gl-leaflet");
      const layer = L.maplibreGL({ style: dark ? STYLE.dark : STYLE.light, attributionControl: false, fadeDuration: 0 });
      layer.options.attribution = MAP_ATTRIBUTION;
      // the map may have closed while MapLibre was loading
      if (!alive()) return null;
      layer.addTo(map);
      const gl = layer.getMaplibreMap();
      // the map is often created while its card is still animating or sizing: the drawing then covered only a corner.
      // Re-measure whenever the map's box changes, and once more after it settles.
      const box = map.getContainer();
      const remeasure = () => { if (alive()) { map.invalidateSize({ pan: false }); gl.resize(); } };
      const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(remeasure) : null;
      observer?.observe(box);
      layer.on("remove", () => observer?.disconnect());
      window.setTimeout(remeasure, 400);
      window.setTimeout(remeasure, 1500);
      // MapLibre drew nothing until the map was first moved: sync and repaint once the style and the first data are in
      const sync = () => {
        if (!alive()) return;
        (layer as unknown as { _update?: () => void })._update?.();
        gl.triggerRepaint();
      };
      gl.once("load", sync);
      gl.once("idle", sync);
      gl.on("sourcedata", (e) => { if (e.isSourceLoaded) gl.triggerRepaint(); });
      const apply = () => { try { tune(gl, dark, language.slice(0, 2)); } catch { /* the map keeps its own style */ } };
      if (gl.isStyleLoaded()) apply(); else gl.once("styledata", apply);
      return layer;
    } catch {
      // fall through to the plain map
    }
  }
  if (!alive()) return null;
  return L.tileLayer(FALLBACK_TILES, { attribution: MAP_ATTRIBUTION, maxZoom: 19, className: fallbackClassName }).addTo(map);
}
