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
// free, keyless, no vendor account. CartoDB's free light_all/dark_all
// tile sets switch with the app's own theme so the map never looks
// like a foreign widget dropped onto a dark UI.
//
// A custom divIcon (not Leaflet's default marker) - the default marker
// image path doesn't resolve correctly once bundled by Vite, and a
// plain brand-colored dot matches this app's own MapPin/token language
// better than Leaflet's default blue pin anyway.
const LIGHT_TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const DARK_TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

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
    const tileLayer = L.tileLayer(resolvedTheme === "dark" ? DARK_TILE_URL : LIGHT_TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 });
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
