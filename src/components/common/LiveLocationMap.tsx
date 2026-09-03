import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { useTheme } from "../../core/context/ThemeContext";
import styles from "./LiveLocationMap.module.css";

// PROSM Time - § live UX review, user-directed: a real, theme-aware
// map on the Dashboard (a reference app's live-location screen studied
// for information hierarchy only, not copied) - the employee's current
// position, and when a site is relevant (clocked in, or picked in the
// Clock In site selector), a translucent circle for that site's real
// geofence radius. Plain Leaflet + OpenStreetMap (no react-leaflet) -
// free, keyless, no vendor account.
//
// § real bug, live-tested: CartoDB's basemaps.cartocdn.com light_all/
// dark_all tiles (this component's original source) now render an
// "API KEY REQUIRED" watermark for unauthenticated requests - CARTO
// retired free anonymous access to that CDN. Switched to plain
// OpenStreetMap standard tiles (genuinely free, no key, no account -
// the one source that still matches what the user actually asked for)
// for BOTH themes, with a CSS invert+hue-rotate filter faking a dark
// variant in dark mode - the standard technique for theming raster OSM
// tiles when no free dark tile source exists.
//
// A custom divIcon (not Leaflet's default marker) - the default marker
// image path doesn't resolve correctly once bundled by Vite, and a
// plain brand-colored dot matches this app's own MapPin/token language
// better than Leaflet's default blue pin anyway.
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function buildMarkerIcon(): L.DivIcon {
  return L.divIcon({
    className: styles.markerIcon,
    html: '<span></span>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

interface LiveLocationMapProps {
  latitude: number | null;
  longitude: number | null;
  site?: { name: string; latitude: number; longitude: number; allowedRadiusMeters: number } | null;
  height?: number;
}

export default function LiveLocationMap({ latitude, longitude, site = null, height = 200 }: LiveLocationMapProps) {
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: false, attributionControl: true, dragging: true, scrollWheelZoom: false });
    map.setView([latitude ?? 30.0444, longitude ?? 31.2357], 15);
    // OpenStreetMap's tile usage policy requires real attribution to
    // stay visible - only Leaflet's own "Leaflet" self-credit prefix
    // (not a license requirement) is dropped, to keep the bar compact.
    map.attributionControl.setPrefix(false);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileLayerRef.current) map.removeLayer(tileLayerRef.current);
    const tileLayer = L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 19,
      className: resolvedTheme === "dark" ? styles.darkTiles : undefined,
    });
    tileLayer.addTo(map);
    tileLayerRef.current = tileLayer;
  }, [resolvedTheme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (markerRef.current) {
      map.removeLayer(markerRef.current);
      markerRef.current = null;
    }
    if (circleRef.current) {
      map.removeLayer(circleRef.current);
      circleRef.current = null;
    }

    if (latitude !== null && longitude !== null) {
      markerRef.current = L.marker([latitude, longitude], { icon: buildMarkerIcon() }).addTo(map);
    }

    if (site) {
      // Leaflet's SVG renderer sets fill/stroke as plain attributes, not
      // via a stylesheet - resolve the real token value at runtime
      // rather than passing a var(...) string, since attribute-context
      // custom-property resolution isn't reliable across WebViews.
      const brandColor = getComputedStyle(document.documentElement).getPropertyValue("--brand-primary").trim() || "#2563eb";
      circleRef.current = L.circle([site.latitude, site.longitude], {
        radius: site.allowedRadiusMeters,
        color: brandColor,
        fillColor: brandColor,
        fillOpacity: 0.15,
        weight: 1.5,
      }).addTo(map);
    }

    if (site) {
      const bounds = L.latLngBounds([[site.latitude, site.longitude]]);
      if (latitude !== null && longitude !== null) bounds.extend([latitude, longitude]);
      bounds.extend(circleRef.current?.getBounds() ?? bounds);
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 });
    } else if (latitude !== null && longitude !== null) {
      map.setView([latitude, longitude], 15);
    }
  }, [latitude, longitude, site]);

  return <div ref={containerRef} className={styles.map} style={{ height }} />;
}
