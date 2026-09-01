import type { RadioStation } from "./RadioBrowserClient";

// PROSM Time - ported from PROSM Platform's own RadioPlaybackEngine (§
// final visual consistency pass, correction 6). A plain module-level
// singleton, NOT a React component/hook, deliberately: playback must
// survive route changes and re-renders, which is only true by
// construction when the <audio> element and its state live outside
// React's render tree entirely. React never creates or unmounts either
// one. Consumed via useRadio() (useSyncExternalStore), same shape as
// Platform's own useRadio(). No favorites/history logging here - see
// RadioBrowserClient.ts's own header comment for why.
export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "reconnecting" | "error";

export interface RadioEngineState {
  currentStation: RadioStation | null;
  playbackState: PlaybackState;
  volume: number;
  isMuted: boolean;
  errorMessage: string | null;
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2000;

type Listener = (state: RadioEngineState) => void;

class RadioPlaybackEngine {
  private audio: HTMLAudioElement | null = null;
  private listeners = new Set<Listener>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private state: RadioEngineState = {
    currentStation: null,
    playbackState: "idle",
    volume: 0.8,
    isMuted: false,
    errorMessage: null,
  };

  private ensureAudioElement(): HTMLAudioElement {
    if (this.audio) return this.audio;

    const audio = new Audio();
    audio.preload = "none";
    audio.volume = this.state.volume;

    audio.addEventListener("playing", () => {
      this.reconnectAttempts = 0;
      this.setState({ playbackState: "playing", errorMessage: null });
    });
    audio.addEventListener("waiting", () => this.setState({ playbackState: "loading" }));
    audio.addEventListener("pause", () => {
      if (this.state.playbackState === "playing" || this.state.playbackState === "loading") {
        this.setState({ playbackState: "paused" });
      }
    });
    audio.addEventListener("error", () => this.handleStreamFailure());
    audio.addEventListener("stalled", () => this.handleStreamFailure());

    this.audio = audio;
    return audio;
  }

  private setState(patch: Partial<RadioEngineState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RadioEngineState => this.state;

  async startPlayback(station: RadioStation) {
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.setState({ currentStation: station, playbackState: "loading", errorMessage: null });

    if (!station.streamUrl) {
      this.setState({ playbackState: "error", errorMessage: "This station's stream could not be resolved." });
      return;
    }

    const audio = this.ensureAudioElement();
    audio.src = station.streamUrl;
    audio.muted = this.state.isMuted;

    try {
      await audio.play();
    } catch {
      this.handleStreamFailure();
    }
  }

  pausePlayback() {
    this.audio?.pause();
  }

  resumePlayback() {
    if (this.audio && this.state.currentStation) {
      this.audio.play().catch(() => this.handleStreamFailure());
    }
  }

  stopPlayback() {
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    }
    this.setState({ currentStation: null, playbackState: "idle", errorMessage: null });
  }

  toggleMute() {
    const nextMuted = !this.state.isMuted;
    if (this.audio) this.audio.muted = nextMuted;
    this.setState({ isMuted: nextMuted });
  }

  setVolume(volume: number) {
    const clamped = Math.min(1, Math.max(0, volume));
    if (this.audio) this.audio.volume = clamped;
    this.setState({ volume: clamped, isMuted: clamped === 0 });
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleStreamFailure() {
    if (!this.state.currentStation) {
      this.setState({ playbackState: "error", errorMessage: "Playback failed." });
      return;
    }

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setState({ playbackState: "error", errorMessage: "Unable to reconnect to this station. Try a different station." });
      return;
    }

    this.reconnectAttempts += 1;
    this.setState({ playbackState: "reconnecting" });

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      if (this.audio && this.state.currentStation) {
        this.audio.play().catch(() => this.handleStreamFailure());
      }
    }, RECONNECT_DELAY_MS);
  }
}

export default new RadioPlaybackEngine();
