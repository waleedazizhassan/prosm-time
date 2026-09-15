import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Sun,
  CloudSun,
  Cloud,
  CloudFog,
  CloudDrizzle,
  CloudRain,
  CloudSnow,
  CloudLightning,
  HelpCircle,
  Droplets,
  Wind,
  Sunrise,
  Sunset,
  Gauge,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

import { getCurrentPosition } from "../../core/utils/geo";
import { formatTimeOnly } from "../../core/utils/formatDate";
import WeatherService, { weatherCategory, windDirectionLabel, getLastKnownWeather, type WeatherData, type WeatherCategory } from "../../core/services/WeatherService";
import styles from "./WeatherMiniPanel.module.css";

const CATEGORY_ICON: Record<WeatherCategory, LucideIcon> = {
  clear: Sun,
  "partly-cloudy": CloudSun,
  cloudy: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  snow: CloudSnow,
  thunderstorm: CloudLightning,
  unknown: HelpCircle,
};

const PANEL_GAP = 10;
const VIEWPORT_MARGIN = 8;
const HOVER_CLOSE_DELAY_MS = 150;

function formatTemp(value: number | null): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)}°`;
}

type Status = "loading" | "ready" | "no-location" | "error";

interface WeatherState {
  status: Status;
  data: WeatherData | null;
  message: string | null;
}

interface PanelStyle {
  top: number;
  left: number;
  maxHeight: number;
}

// Ported from PROSM Platform's own Header/WeatherMiniPanel (§ visual
// consistency pass, item 5). Answers one question only: "what's the
// weather where the viewer actually is" - geolocation or an explicit
// "Location unavailable" state, never a substitute location. Portaled
// to document.body so the expanded panel escapes the Header's own
// stacking/overflow, positioned against the trigger's real
// getBoundingClientRect() with viewport-collision handling.
export default function WeatherMiniPanel() {
  const { t, i18n } = useTranslation("shell");

  // § user-reported real perf issue (#11, 2026-09-15) - hydrate
  // synchronously from the last real fetch (if still within the
  // normal cache TTL) so the pill shows real data immediately on
  // mount instead of a loading skeleton every single time - the
  // effect below still kicks off a real, fresh geolocation+fetch to
  // correct this if the viewer has genuinely moved since.
  const hydratedFromCacheRef = useRef(false);
  const [state, setState] = useState<WeatherState>(() => {
    const cached = getLastKnownWeather();
    hydratedFromCacheRef.current = Boolean(cached);
    return cached ? { status: "ready", data: cached, message: null } : { status: "loading", data: null, message: null };
  });
  const [expanded, setExpanded] = useState(false);
  const [panelStyle, setPanelStyle] = useState<PanelStyle | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const supportsHoverRef = useRef(typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches);

  const cancelScheduledClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openOnHover = () => {
    if (!supportsHoverRef.current) return;
    cancelScheduledClose();
    setExpanded(true);
  };

  const scheduleCloseOnHover = () => {
    if (!supportsHoverRef.current) return;
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => setExpanded(false), HOVER_CLOSE_DELAY_MS);
  };

  // silent: the initial mount's background refresh, when a cached
  // value already hydrated state synchronously above - never flashes
  // a loading skeleton over real (if slightly stale) data already on
  // screen, and never replaces it with an error/no-location state if
  // this particular background refresh fails (the cached data stays
  // shown; a later manual refresh or the next natural reload tries
  // again for real).
  const load = async (forceRefresh = false, silent = false) => {
    if (!silent) setState((previous) => ({ ...previous, status: "loading" }));

    try {
      // § user-reported real perf issue (#11, 2026-09-15) - weather
      // only needs city-level precision, not the real GPS-fix
      // high-accuracy geofence enforcement needs (see geo.ts's own
      // header comment) - a fast, low-accuracy, short-timeout request
      // resolves almost immediately on real devices instead of waiting
      // out a real GPS fix (or its full 10s timeout) every load.
      const position = await getCurrentPosition({ highAccuracy: false, timeoutMs: 5000 });
      const geoResult = await WeatherService.getWeatherForCoordinates(position.latitude, position.longitude, { forceRefresh });

      if (geoResult.success) {
        setState({ status: "ready", data: geoResult.data, message: null });
        return;
      }

      if (!silent) setState({ status: "error", data: null, message: geoResult.message });
    } catch {
      if (!silent) setState({ status: "no-location", data: null, message: null });
    }
  };

  useEffect(() => {
    load(false, hydratedFromCacheRef.current);
  }, []);

  useEffect(() => {
    if (!expanded) return undefined;

    const handleClickOutside = (event: MouseEvent) => {
      const clickedTrigger = containerRef.current?.contains(event.target as Node);
      const clickedPanel = panelRef.current?.contains(event.target as Node);
      if (!clickedTrigger && !clickedPanel) {
        setExpanded(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [expanded]);

  useEffect(() => cancelScheduledClose, []);

  useLayoutEffect(() => {
    if (!expanded) {
      setPanelStyle(null);
      return undefined;
    }

    const computePosition = () => {
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      const panelEl = panelRef.current;
      if (!triggerRect || !panelEl) return;

      const panelWidth = panelEl.offsetWidth;
      const panelHeight = panelEl.offsetHeight;

      const spaceAbove = triggerRect.top - PANEL_GAP - VIEWPORT_MARGIN;
      const spaceBelow = window.innerHeight - triggerRect.bottom - PANEL_GAP - VIEWPORT_MARGIN;

      const openUpward = spaceAbove >= panelHeight || spaceAbove >= spaceBelow;
      const availableSpace = Math.max(openUpward ? spaceAbove : spaceBelow, 120);

      const top = openUpward ? Math.max(VIEWPORT_MARGIN, triggerRect.top - PANEL_GAP - panelHeight) : triggerRect.bottom + PANEL_GAP;

      const isRtl = document.documentElement.dir === "rtl";
      let left = isRtl ? triggerRect.right - panelWidth : triggerRect.left;
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - panelWidth - VIEWPORT_MARGIN));

      setPanelStyle({ top, left, maxHeight: Math.min(availableSpace, window.innerHeight - VIEWPORT_MARGIN * 2) });
    };

    computePosition();

    window.addEventListener("resize", computePosition);
    window.addEventListener("scroll", computePosition, true);

    return () => {
      window.removeEventListener("resize", computePosition);
      window.removeEventListener("scroll", computePosition, true);
    };
  }, [expanded, state.status, state.data]);

  const category = state.data ? weatherCategory(state.data.weatherCode) : "unknown";
  const Icon = CATEGORY_ICON[category] ?? HelpCircle;
  const isPanelVisible = expanded && panelStyle !== null;

  const formatClockTime = (iso: string | null) => (iso ? formatTimeOnly(iso, i18n.language) : "—");

  return (
    <div ref={containerRef} className={styles.container}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.pill}
        onClick={(event) => {
          if (supportsHoverRef.current && event.detail > 0) return;

          if (state.status === "no-location") {
            load(true);
            return;
          }

          setExpanded((value) => !value);
        }}
        onMouseEnter={openOnHover}
        onMouseLeave={scheduleCloseOnHover}
        aria-expanded={state.status === "no-location" ? undefined : expanded}
        aria-haspopup={state.status === "no-location" ? undefined : "true"}
        title={state.status === "no-location" ? (t("weather.retryLocation") as string) : undefined}
      >
        {state.status === "loading" && <span className={styles.pillSkeleton} aria-label={t("weather.loading") as string} />}

        {state.status === "error" && (
          <>
            <HelpCircle size={16} />
            <span className={styles.pillText}>{t("weather.unavailable")}</span>
          </>
        )}

        {state.status === "no-location" && (
          <>
            <HelpCircle size={16} />
            <span className={styles.pillText}>{t("weather.locationUnavailable")}</span>
          </>
        )}

        {state.status === "ready" && state.data && (
          <>
            <Icon size={16} className={styles.pillIcon} />
            <span className={styles.pillTemp}>{formatTemp(state.data.temperature)}</span>
          </>
        )}
      </button>

      {expanded &&
        state.status === "ready" &&
        state.data &&
        createPortal(
          <div
            ref={panelRef}
            className={styles.expanded}
            role="dialog"
            aria-label={t("weather.detailsLabel") as string}
            onMouseEnter={openOnHover}
            onMouseLeave={scheduleCloseOnHover}
            style={{ top: panelStyle?.top ?? 0, left: panelStyle?.left ?? 0, maxHeight: panelStyle?.maxHeight, visibility: isPanelVisible ? "visible" : "hidden" }}
          >
            <div className={styles.expandedHeader}>
              <Icon size={30} />
              <div>
                <div className={styles.expandedTemp}>{formatTemp(state.data.temperature)}</div>
                <div className={styles.expandedCondition}>{t(`weather.categories.${category}`)}</div>
                <div className={styles.expandedCity}>{state.data.cityName ?? t("weather.yourLocation")}</div>
              </div>

              <button type="button" className={styles.refreshButton} onClick={(event) => { event.stopPropagation(); load(true); }} aria-label={t("weather.refresh") as string} title={t("weather.refresh") as string}>
                <RefreshCw size={13} />
              </button>
            </div>

            <div className={styles.grid}>
              <div className={styles.gridItem}>
                <span className={styles.gridLabel}>{t("weather.feelsLike")}</span>
                <span className={styles.gridValue}>{formatTemp(state.data.feelsLike)}</span>
              </div>

              <div className={styles.gridItem}>
                <Droplets size={12} className={styles.gridIcon} />
                <span className={styles.gridLabel}>{t("weather.humidity")}</span>
                <span className={styles.gridValue}>{state.data.humidity ?? "—"}%</span>
              </div>

              <div className={styles.gridItem}>
                <Wind size={12} className={styles.gridIcon} />
                <span className={styles.gridLabel}>{t("weather.wind")}</span>
                <span className={styles.gridValue}>
                  {state.data.windSpeed ?? "—"} km/h {windDirectionLabel(state.data.windDirection)}
                </span>
              </div>

              <div className={styles.gridItem}>
                <Gauge size={12} className={styles.gridIcon} />
                <span className={styles.gridLabel}>{t("weather.uvIndex")}</span>
                <span className={styles.gridValue}>{state.data.uvIndex ?? "—"}</span>
              </div>

              <div className={styles.gridItem}>
                <span className={styles.gridLabel}>{t("weather.dailyHigh")}</span>
                <span className={styles.gridValue}>{formatTemp(state.data.tempMax)}</span>
              </div>

              <div className={styles.gridItem}>
                <span className={styles.gridLabel}>{t("weather.dailyLow")}</span>
                <span className={styles.gridValue}>{formatTemp(state.data.tempMin)}</span>
              </div>

              <div className={styles.gridItem}>
                <Sunrise size={12} className={styles.gridIcon} />
                <span className={styles.gridLabel}>{t("weather.sunrise")}</span>
                <span className={styles.gridValue}>{formatClockTime(state.data.sunrise)}</span>
              </div>

              <div className={styles.gridItem}>
                <Sunset size={12} className={styles.gridIcon} />
                <span className={styles.gridLabel}>{t("weather.sunset")}</span>
                <span className={styles.gridValue}>{formatClockTime(state.data.sunset)}</span>
              </div>
            </div>

            <div className={styles.updatedRow}>
              {t("weather.lastUpdated", { time: formatClockTime(state.data.fetchedAt) })}
            </div>
          </div>,
          document.body
        )}

      {expanded &&
        state.status === "error" &&
        createPortal(
          <div
            ref={panelRef}
            className={styles.expanded}
            role="dialog"
            aria-label={t("weather.detailsLabel") as string}
            onMouseEnter={openOnHover}
            onMouseLeave={scheduleCloseOnHover}
            style={{ top: panelStyle?.top ?? 0, left: panelStyle?.left ?? 0, maxHeight: panelStyle?.maxHeight, visibility: isPanelVisible ? "visible" : "hidden" }}
          >
            <p className={styles.errorText}>{state.message ?? t("weather.genericError")}</p>
            <button type="button" className={styles.refreshButton} onClick={(event) => { event.stopPropagation(); load(true); }}>
              <RefreshCw size={13} />
              {t("weather.tryAgain")}
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
