import { useTranslation } from "react-i18next";
import { Play, Pause, Square, Volume2, VolumeX, Search, Loader2 } from "lucide-react";

import RadioPlaybackEngine from "../../core/services/RadioPlaybackEngine";
import useRadio from "../../core/hooks/useRadio";
import useRadioStations from "../../core/hooks/useRadioStations";
import styles from "./SidebarRadio.module.css";

// PROSM Time - § live UX review, user-directed: "on mobile, take the
// radio out of the header entirely and put it in the sidebar under a
// Media heading - nicer than cramming it into the header." Same
// station data/search as HeaderRadio (useRadioStations, shared) - this
// is purely a different, inline layout for the mobile drawer, always
// "expanded" (there's no trigger pill to click here, the whole section
// just IS the radio). Rendered only inside Sidebar.tsx, which itself
// is CSS-hidden on desktop at the same breakpoint HeaderRadio is
// hidden at on mobile (900px) - never both at once.
export default function SidebarRadio() {
  const { t } = useTranslation("shell");
  const radio = useRadio();
  const { query, setQuery, stationList, searching } = useRadioStations(true);

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

  return (
    <div className={styles.container}>
      <p className={styles.sectionLabel}>{t("radio.mediaSectionTitle")}</p>

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
    </div>
  );
}
