import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LocateFixed, Maximize2, Minimize2 } from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { useTheme } from "../../../core/context/ThemeContext";
import { isRtl } from "../../../i18n/direction";
import type { DashboardPresent, DashboardSite } from "../../../core/repositories/DashboardRepository";
import mapStyles from "../../../components/common/LiveLocationMap.module.css";
import styles from "./ManagerDashboard.module.css";

const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = "© OpenStreetMap";

// metres between two points (for "is this person inside that site's circle")
function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Owner 2026-11-10: where each person really is - their last point, else where they clocked in, else
// (no point at all) their site's centre - and the site whose circle they are inside, if any.
function placeOf(person: DashboardPresent, sites: DashboardSite[]) {
  const own = person.siteId ? sites.find((x) => x.id === person.siteId) : undefined;
  const lat = person.lastLatitude ?? person.latitude ?? own?.latitude ?? null;
  const lng = person.lastLongitude ?? person.longitude ?? own?.longitude ?? null;
  if (lat === null || lng === null) return { lat: null, lng: null, siteId: null as string | null };
  const inside = sites.find((s) => s.latitude !== null && s.longitude !== null && metres(lat, lng, s.latitude, s.longitude) <= s.radius + 50);
  return { lat, lng, siteId: inside?.id ?? null };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

// shift (in pixels) for the i-th of n avatars on the same spot, so none hides under another
function spread(i: number, n: number): [number, number] {
  if (n <= 1) return [0, 0];
  const r = n <= 6 ? 18 : 18 + (n - 6) * 3;
  const a = (2 * Math.PI * i) / n - Math.PI / 2;
  return [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))];
}

function personIcon(person: DashboardPresent, shift: [number, number] = [0, 0]): L.DivIcon {
  const initial = escapeHtml(person.name.trim().charAt(0).toUpperCase() || "?");
  const ring = person.status === "outside" ? "#ea580c" : person.status === "long" ? "#dc2626" : person.status === "break" ? "#d97706" : "#16a34a";
  // a safe URL only (https), shown as a background, never as markup
  const photo = person.avatarUrl && /^https:\/\//.test(person.avatarUrl) ? `background-image:url('${person.avatarUrl.replace(/'/g, "%27")}');` : "";
  return L.divIcon({
    className: "",
    html: `<span style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;border:3px solid ${ring};background:#e0ecff center/cover no-repeat;${photo}color:#1e3a8a;font:600 13px system-ui;box-shadow:0 1px 4px rgba(0,0,0,.35)">${photo ? "" : initial}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15 - shift[0], 15 - shift[1]],
  });
}

// v2.3.43 step 17 (item 4): the sites now - each site's real work-area
// circle (green; red with an active SOS), how many are there, the people
// clocked in as their photo (ring colour = status, orange when outside the
// area). Only real sites and real people; full-screen on demand.
export default function SitesMap({ sites, people }: { sites: DashboardSite[]; people: DashboardPresent[] }) {
  const { t, i18n } = useTranslation("dashboard");
  const { resolvedTheme } = useTheme();
  const rtl = isRtl(i18n.language);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  // owner 2026-10-26: back to every site at once, and a key under the map
  const allBoundsRef = useRef<L.LatLngBounds | null>(null);
  const circlesRef = useRef(new Map<string, L.Circle>());
  const [fullScreen, setFullScreen] = useState(false);
  const markersRef = useRef(new Map<string, L.Marker>());
  // who is inside which site's circle right now, and who is at none of them ("different places")
  const placed = useMemo(() => people.map((person) => ({ person, ...placeOf(person, sites) })), [people, sites]);
  const insideCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of placed) if (p.siteId) counts.set(p.siteId, (counts.get(p.siteId) ?? 0) + 1);
    return counts;
  }, [placed]);
  const elsewhere = useMemo(() => placed.filter((p) => !p.siteId), [placed]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: false, scrollWheelZoom: false });
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

  // B-08: our own buttons sit at the inline start (full screen, all sites); the zoom (+/-) sits at
  // the inline end, so the two never overlap - and it moves when the language changes direction.
  // Leaflet places controls by physical side, so the side is chosen from the direction here.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const zoom = L.control.zoom({ position: rtl ? "topleft" : "topright", zoomInTitle: t("manager.map.zoomIn"), zoomOutTitle: t("manager.map.zoomOut") }).addTo(map);
    return () => {
      try {
        zoom.remove();
      } catch {
        // the map itself was already removed
      }
    };
  }, [rtl, t]);

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
    circlesRef.current.clear();
    const bounds = L.latLngBounds([]);
    for (const site of sites) {
      if (site.latitude === null || site.longitude === null) continue;
      // red with an SOS, green with people there now, grey when nobody is there
      const here = insideCount.get(site.id) ?? 0;
      const color = siteColor(site, here);
      const circle = L.circle([site.latitude, site.longitude], { radius: site.radius, color, fillColor: color, fillOpacity: 0.12, weight: 1.5 });
      circle.bindTooltip(`${escapeHtml(site.name)} · ${here}${site.expected ? ` / ${site.expected}` : ""}${site.external?.presentNow ? ` · ${escapeHtml(t("manager.map.external", { count: site.external.presentNow }))}` : ""}`, { permanent: true, direction: "top", className: styles.siteLabel, interactive: true });
      // owner 2026-10-26: a click on the site's name (or its circle) zooms to the site
      circle.on("click", () => map.flyToBounds(circle.getBounds(), { padding: [24, 24], maxZoom: 17, duration: 0.6 }));
      circle.addTo(layer);
      circlesRef.current.set(site.id, circle);
      bounds.extend(circle.getBounds());
    }
    // Owner 2026-11-10 ("only Mohamed is not showing"): people on the same spot (the same site centre,
    // or the same point within ~10 m) sat exactly on top of each other - they now fan out around it.
    const spotKey = (lat: number, lng: number) => `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const onSpot = new Map<string, number>();
    for (const p of placed) if (p.lat !== null && p.lng !== null) onSpot.set(spotKey(p.lat, p.lng), (onSpot.get(spotKey(p.lat, p.lng)) ?? 0) + 1);
    const seen = new Map<string, number>();
    markersRef.current.clear();
    for (const { person, lat, lng } of placed) {
      // Owner 2026-11-10: everyone clocked in is on the map, where they really are
      if (lat === null || lng === null) continue;
      const key = spotKey(lat, lng);
      const i = seen.get(key) ?? 0;
      seen.set(key, i + 1);
      const marker = L.marker([lat, lng], { icon: personIcon(person, spread(i, onSpot.get(key) ?? 1)) })
        .bindTooltip(`${escapeHtml(person.name)}${person.siteName ? ` · ${escapeHtml(person.siteName)}` : ""}`)
        .addTo(layer);
      markersRef.current.set(person.userId, marker);
      bounds.extend([lat, lng]);
    }
    allBoundsRef.current = bounds.isValid() ? bounds : null;
    if (bounds.isValid() && !fittedRef.current) {
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
      fittedRef.current = true;
    }
  }, [sites, placed, t, insideCount]);

  useEffect(() => {
    const timer = window.setTimeout(() => mapRef.current?.invalidateSize(), 120);
    return () => window.clearTimeout(timer);
  }, [fullScreen]);

  const showAll = () => {
    if (allBoundsRef.current) mapRef.current?.flyToBounds(allBoundsRef.current, { padding: [28, 28], maxZoom: 16, duration: 0.6 });
  };
  const goTo = (siteId: string) => {
    const circle = circlesRef.current.get(siteId);
    if (circle) mapRef.current?.flyToBounds(circle.getBounds(), { padding: [24, 24], maxZoom: 17, duration: 0.6 });
  };
  // the key: every site on the map, the ones with people first
  const keyed = sites
    .filter((site) => site.latitude !== null && site.longitude !== null)
    .sort((a, b) => Number(b.sos) - Number(a.sos) || (insideCount.get(b.id) ?? 0) - (insideCount.get(a.id) ?? 0));
  // Owner 2026-11-10: a site's item lists the people inside it, as "outside the sites" does - each
  // name goes to that person; a tap anywhere outside the list closes it and the map stays where it is.
  const [listFor, setListFor] = useState<string | null>(null);
  const unplaced = elsewhere.map((p) => p.person);
  const listedPeople = listFor === null ? [] : listFor === ELSEWHERE ? unplaced : placed.filter((p) => p.siteId === listFor).map((p) => p.person);
  const keyRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listFor === null) return undefined;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (listRef.current?.contains(target) || keyRef.current?.contains(target)) return;
      setListFor(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [listFor]);
  // tap "outside the sites": the map shows all of them, and their names open under it
  const showElsewhere = () => {
    setListFor((v) => (v === ELSEWHERE ? null : ELSEWHERE));
    const points = elsewhere.filter((p) => p.lat !== null && p.lng !== null).map((p) => [p.lat as number, p.lng as number] as [number, number]);
    if (points.length > 0) mapRef.current?.flyToBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 14, duration: 0.6 });
  };
  const showSite = (siteId: string) => {
    goTo(siteId);
    setListFor((v) => (v === siteId || (insideCount.get(siteId) ?? 0) === 0 ? null : siteId));
  };

  // a name in the list: the map goes to that person and shows their name
  const goToPerson = (userId: string) => {
    const marker = markersRef.current.get(userId);
    if (!marker) return;
    mapRef.current?.flyTo(marker.getLatLng(), Math.max(mapRef.current.getZoom(), 15), { duration: 0.6 });
    marker.openTooltip();
  };

  return (
    <div className={fullScreen ? styles.mapFullScreen : styles.mapBox}>
      <div ref={containerRef} className={styles.mapCanvas} />
      <button type="button" className={styles.mapButton} onClick={() => setFullScreen((value) => !value)} aria-label={fullScreen ? t("manager.map.exitFullScreen") : t("manager.map.fullScreen")}>
        {fullScreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      <button type="button" className={`${styles.mapButton} ${styles.mapButtonSecond}`} onClick={showAll} aria-label={t("manager.map.showAll")} title={t("manager.map.showAll")}>
        <LocateFixed size={16} />
      </button>
      {keyed.length > 0 || unplaced.length > 0 ? (
        <div ref={keyRef} className={styles.mapKey} role="group" aria-label={t("manager.map.keyLabel")}>
          {keyed.map((site) => (
            <button key={site.id} type="button" className={styles.mapKeyItem} onClick={() => showSite(site.id)} aria-expanded={listFor === site.id} title={site.sos ? t("manager.map.stateSos") : (insideCount.get(site.id) ?? 0) > 0 ? t("manager.map.stateActive") : t("manager.map.stateIdle")}>
              <span className={styles.mapKeyDot} style={{ background: siteColor(site, insideCount.get(site.id) ?? 0) }} aria-hidden="true" />
              <span>{site.name}</span>
              <b>{insideCount.get(site.id) ?? 0}</b>
            </button>
          ))}
          {/* Owner 2026-11-10: everyone who is at none of the sites is one item, "different places" -
              tap: the map shows them all and their names open */}
          {unplaced.length > 0 ? (
            <button type="button" className={styles.mapKeyItem} onClick={showElsewhere} aria-expanded={listFor === ELSEWHERE} title={unplaced.map((p) => p.name).join("، ")}>
              <span className={styles.mapKeyDot} style={{ background: "#f59e0b" }} aria-hidden="true" />
              <span>{t("manager.map.elsewhere")}</span>
              <b>{unplaced.length}</b>
            </button>
          ) : null}
        </div>
      ) : null}
      {listedPeople.length > 0 ? (
        <div ref={listRef} className={styles.mapUnplaced} role="status">
          {listedPeople.map((person) => (
            <button key={person.userId} type="button" className={styles.mapUnplacedName} onClick={() => goToPerson(person.userId)}>
              {person.name}{person.siteName ? ` · ${person.siteName}` : ""}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const ELSEWHERE = "__elsewhere__";

function siteColor(site: DashboardSite, here: number): string {
  if (site.sos) return "#dc2626";
  return here > 0 ? "#16a34a" : "#94a3b8";
}
