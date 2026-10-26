import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Maximize2, Minimize2 } from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { useTheme } from "../../../core/context/ThemeContext";
import type { DashboardPresent, DashboardSite } from "../../../core/repositories/DashboardRepository";
import mapStyles from "../../../components/common/LiveLocationMap.module.css";
import styles from "./ManagerDashboard.module.css";

const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function personIcon(person: DashboardPresent): L.DivIcon {
  const initial = escapeHtml(person.name.trim().charAt(0).toUpperCase() || "?");
  const ring = person.status === "outside" ? "#ea580c" : person.status === "long" ? "#dc2626" : person.status === "break" ? "#d97706" : "#16a34a";
  // a safe URL only (https), shown as a background, never as markup
  const photo = person.avatarUrl && /^https:\/\//.test(person.avatarUrl) ? `background-image:url('${person.avatarUrl.replace(/'/g, "%27")}');` : "";
  return L.divIcon({
    className: "",
    html: `<span style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;border:3px solid ${ring};background:#e0ecff center/cover no-repeat;${photo}color:#1e3a8a;font:600 13px system-ui;box-shadow:0 1px 4px rgba(0,0,0,.35)">${photo ? "" : initial}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// v2.3.43 step 17 (item 4): the sites now - each site's real work-area
// circle (green; red with an active SOS), how many are there, the people
// clocked in as their photo (ring colour = status, orange when outside the
// area). Only real sites and real people; full-screen on demand.
export default function SitesMap({ sites, people }: { sites: DashboardSite[]; people: DashboardPresent[] }) {
  const { t } = useTranslation("dashboard");
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true, scrollWheelZoom: false });
    map.attributionControl.setPrefix(false);
    map.setView([30.0444, 31.2357], 11);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      tileRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileRef.current) map.removeLayer(tileRef.current);
    tileRef.current = L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19, className: resolvedTheme === "dark" ? mapStyles.darkTiles : undefined }).addTo(map);
  }, [resolvedTheme]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const bounds = L.latLngBounds([]);
    for (const site of sites) {
      if (site.latitude === null || site.longitude === null) continue;
      const color = site.sos ? "#dc2626" : "#16a34a";
      const circle = L.circle([site.latitude, site.longitude], { radius: site.radius, color, fillColor: color, fillOpacity: 0.12, weight: 1.5 });
      circle.bindTooltip(`${escapeHtml(site.name)} · ${site.present}${site.expected ? ` / ${site.expected}` : ""}${site.external?.presentNow ? ` · ${escapeHtml(t("manager.map.external", { count: site.external.presentNow }))}` : ""}`, { permanent: true, direction: "top", className: styles.siteLabel, interactive: true });
      // owner 2026-10-26: a click on the site's name (or its circle) zooms to the site
      circle.on("click", () => map.flyToBounds(circle.getBounds(), { padding: [24, 24], maxZoom: 17, duration: 0.6 }));
      circle.addTo(layer);
      bounds.extend(circle.getBounds());
    }
    for (const person of people) {
      const lat = person.lastLatitude ?? person.latitude;
      const lng = person.lastLongitude ?? person.longitude;
      if (lat === null || lng === null) continue;
      L.marker([lat, lng], { icon: personIcon(person) })
        .bindTooltip(`${escapeHtml(person.name)}${person.siteName ? ` · ${escapeHtml(person.siteName)}` : ""}`)
        .addTo(layer);
      bounds.extend([lat, lng]);
    }
    if (bounds.isValid() && !fittedRef.current) {
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
      fittedRef.current = true;
    }
  }, [sites, people, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => mapRef.current?.invalidateSize(), 120);
    return () => window.clearTimeout(timer);
  }, [fullScreen]);

  return (
    <div className={fullScreen ? styles.mapFullScreen : styles.mapBox}>
      <div ref={containerRef} className={styles.mapCanvas} />
      <button type="button" className={styles.mapButton} onClick={() => setFullScreen((value) => !value)} aria-label={fullScreen ? t("manager.map.exitFullScreen") : t("manager.map.fullScreen")}>
        {fullScreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
    </div>
  );
}
