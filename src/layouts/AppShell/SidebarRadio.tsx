import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, Square, Volume2, VolumeX, Search, Loader2, Radio as RadioIcon, ChevronDown } from "lucide-react";

import RadioPlaybackEngine from "../../core/services/RadioPlaybackEngine";
import useRadio from "../../core/hooks/useRadio";
import useRadioStations from "../../core/hooks/useRadioStations";
import styles from "./SidebarRadio.module.css";

// PROSM Time - § live UX review, user-directed: "on mobile, take the
// radio out of the header entirely and put it in the sidebar under a
// Media heading" (original placement), then "the radio takes up too
// much space in the sidebar, make it smaller" (this pass). Same
// station data/search as HeaderRadio (useRadioStations, shared) - only
// the layout changed: collapsed by default to one compact row (icon +
// current station/status + play-pause), matching the height of an
// ordinary nav item instead of a permanent ~300-400px block. The
// search box and station list are revealed via the row's own
// expand/collapse toggle - nothing about playback/search logic itself
// changed.
export default function SidebarRadio() {
  const { t } = useTranslation("shell");
  const radio = useRadio();
  const [expanded, setExpanded] = useState(false);
  // § real perf bug, found while investigating #11 (2026-09-15,
  // "Radio... very slow to load") - this was hardcoded `true` instead
  // of `expanded`, unlike HeaderRadio.tsx's own correct usage of the
  // exact same hook. SidebarRadio is unconditionally mounted in
  // Sidebar.tsx (collapsed by default, one compact row) - every real
  // app session was firing 4 parallel Radio Browser API requests on
  // load whether or not the user ever touched the radio at all. Now
  // lazy, same as the Header's own version - stations only fetch once
  // this row is actually expanded.
  const { query, setQuery, stationList, searching } = useRadioStations(expanded);

  const handlePlay = (station: (typeof stationList)[number]) => {
    RadioPlaybackEngine.startPlayback(station);
  };

  const handleTogglePlayPause = () => {
    if (radio.playbackState === "playing" || radio.playbackState === "loading") {
      RadioPlaybackEngine.pausePlayback();
    } else {
      RadioPlaybackEngine.resumePlayback();
    }
  };

  const isPlaying = radio.playbackState === "playing" || radio.playbackState === "loading";

  const statusText =
    radio.playbackState === "loading"
      ? t("radio.loading")
      : radio.playbackState === "reconnecting"
        ? t("radio.reconnecting")
        : radio.playbackState === "error"
          ? (radio.errorMessage ?? t("radio.error"))
          : radio.playbackState === "paused"
            ? t("radio.paused")
            : t("radio.playing");

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <button type="button" className={styles.headerToggle} onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
          <RadioIcon size={14} className={styles.headerIcon} />
          <span className={styles.headerLabel}>{radio.currentStation ? radio.currentStation.name : t("radio.mediaSectionTitle")}</span>
          <ChevronDown size={14} className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`} />
        </button>
        {radio.currentStation ? (
          <button type="button" className={styles.iconButton} onClick={handleTogglePlayPause} aria-label={isPlaying ? t("radio.pauseAction") : t("radio.playAction")}>
            {radio.playbackState === "loading" || radio.playbackState === "reconnecting" ? <Loader2 size={14} className={styles.spinning} /> : isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <>
          {radio.currentStation ? (
            <div className={styles.nowPlaying}>
              <span className={styles.nowPlayingStatus}>{statusText}</span>
              <div className={styles.nowPlayingControls}>
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
        </>
      ) : null}
    </div>
  );
}
