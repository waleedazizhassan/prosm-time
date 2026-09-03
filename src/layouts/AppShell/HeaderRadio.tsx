import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Radio as RadioIcon, Play, Pause, Square, Volume2, VolumeX, Search, Loader2 } from "lucide-react";

import RadioBrowserClient, { type RadioStation } from "../../core/services/RadioBrowserClient";
import RadioPlaybackEngine from "../../core/services/RadioPlaybackEngine";
import useRadio from "../../core/hooks/useRadio";
import styles from "./HeaderRadio.module.css";

const PANEL_GAP = 10;
const VIEWPORT_MARGIN = 8;

// PROSM Time - a scoped Header Radio widget (§ final visual
// consistency pass, correction 6: "Implement the Header Radio using
// the existing/proven PROSM Platform Center radio capability/pattern
// where applicable. Do not invent a separate radio architecture.").
// Search + play, reusing Platform's own Radio Browser provider
// approach (RadioBrowserClient.ts) and playback engine
// (RadioPlaybackEngine.ts) ported at the capability level. Favorites
// and play history are intentionally not included - see this
// project's own documented Radio scoping decision (Platform's
// Favorites/History are backed by Platform's own separate Supabase
// project; building that here would mean either new backend
// infrastructure or a cross-project integration, both out of scope for
// a visual/UX finishing pass).
export default function HeaderRadio() {
  const { t } = useTranslation("shell");
  const radio = useRadio();

  const [expanded, setExpanded] = useState(false);
  const [panelStyle, setPanelStyle] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RadioStation[]>([]);
  const [defaultStations, setDefaultStations] = useState<RadioStation[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadedDefaults, setLoadedDefaults] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!expanded || loadedDefaults) return;
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
  }, [expanded, loadedDefaults]);

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

  useEffect(() => {
    if (!expanded) return undefined;

    const handleClickOutside = (event: MouseEvent) => {
      const clickedTrigger = containerRef.current?.contains(event.target as Node);
      const clickedPanel = panelRef.current?.contains(event.target as Node);
      if (!clickedTrigger && !clickedPanel) setExpanded(false);
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
      const spaceBelow = window.innerHeight - triggerRect.bottom - PANEL_GAP - VIEWPORT_MARGIN;
      const top = triggerRect.bottom + PANEL_GAP;

      const isRtl = document.documentElement.dir === "rtl";
      let left = isRtl ? triggerRect.right - panelWidth : triggerRect.left;
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - panelWidth - VIEWPORT_MARGIN));

      setPanelStyle({ top, left, maxHeight: Math.max(spaceBelow, 240) });
    };

    computePosition();
    window.addEventListener("resize", computePosition);
    window.addEventListener("scroll", computePosition, true);
    return () => {
      window.removeEventListener("resize", computePosition);
      window.removeEventListener("scroll", computePosition, true);
    };
  }, [expanded, results.length, defaultStations.length]);

  const handlePlay = (station: RadioStation) => {
    RadioPlaybackEngine.startPlayback(station);
  };

  const handleTogglePlayPause = () => {
    if (radio.playbackState === "playing" || radio.playbackState === "loading") {
      RadioPlaybackEngine.pausePlayback();
    } else {
      RadioPlaybackEngine.resumePlayback();
    }
  };

  const stationList = query.trim() ? results : defaultStations;
  const isPlaying = radio.playbackState === "playing" || radio.playbackState === "loading";
  const isPanelVisible = expanded && panelStyle !== null;

  return (
    <div ref={containerRef} className={styles.container}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.pill} ${radio.currentStation ? styles.pillActive : ""}`}
        onClick={() => setExpanded((value) => !value)}
        aria-haspopup="true"
        aria-expanded={expanded}
        title={radio.currentStation ? radio.currentStation.name : t("radio.title")}
      >
        <RadioIcon size={16} />
        {radio.currentStation ? <span className={styles.pillText}>{radio.currentStation.name}</span> : null}
      </button>

      {expanded &&
        createPortal(
          <div
            ref={panelRef}
            className={styles.expanded}
            role="dialog"
            aria-label={t("radio.title")}
            style={{ top: panelStyle?.top ?? 0, left: panelStyle?.left ?? 0, maxHeight: panelStyle?.maxHeight, visibility: isPanelVisible ? "visible" : "hidden" }}
          >
            {radio.currentStation ? (
              <div className={styles.nowPlaying}>
                <div className={styles.nowPlayingInfo}>
                  <span className={styles.nowPlayingName}>{radio.currentStation.name}</span>
                  <span className={styles.nowPlayingStatus}>
                    {radio.playbackState === "loading"
                      ? t("radio.loading")
                      : radio.playbackState === "reconnecting"
                        ? t("radio.reconnecting")
                        : radio.playbackState === "error"
                          ? radio.errorMessage ?? t("radio.error")
                          : radio.playbackState === "paused"
                            ? t("radio.paused")
                            : t("radio.playing")}
                  </span>
                </div>
                <div className={styles.nowPlayingControls}>
                  <button type="button" className={styles.iconButton} onClick={handleTogglePlayPause} aria-label={isPlaying ? t("radio.pauseAction") : t("radio.playAction")}>
                    {radio.playbackState === "loading" || radio.playbackState === "reconnecting" ? <Loader2 size={16} className={styles.spinning} /> : isPlaying ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <button type="button" className={styles.iconButton} onClick={() => RadioPlaybackEngine.stopPlayback()} aria-label={t("radio.stopAction")}>
                    <Square size={14} />
                  </button>
                  <button type="button" className={styles.iconButton} onClick={() => RadioPlaybackEngine.toggleMute()} aria-label={radio.isMuted ? t("radio.unmuteAction") : t("radio.muteAction")}>
                    {radio.isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={radio.isMuted ? 0 : radio.volume}
                    onChange={(event) => RadioPlaybackEngine.setVolume(Number(event.target.value))}
                    className={styles.volumeSlider}
                    aria-label={t("radio.volumeLabel")}
                  />
                </div>
              </div>
            ) : null}

            <div className={styles.searchRow}>
              <Search size={14} className={styles.searchIcon} />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("radio.searchPlaceholder") as string}
                className={styles.searchInput}
              />
            </div>

            <div className={styles.stationList}>
              {searching ? (
                <div className={styles.stateMessage}>{t("radio.searching")}</div>
              ) : stationList.length === 0 ? (
                <div className={styles.stateMessage}>{query.trim() ? t("radio.noResults") : t("radio.loadingStations")}</div>
              ) : (
                stationList.map((station) => (
                  <button
                    key={station.stationUuid}
                    type="button"
                    className={`${styles.stationRow} ${radio.currentStation?.stationUuid === station.stationUuid ? styles.stationRowActive : ""}`}
                    onClick={() => handlePlay(station)}
                  >
                    <span className={styles.stationName}>{station.name}</span>
                    <span className={styles.stationMeta}>{station.country ?? station.tags[0] ?? ""}</span>
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
