import { Component, type ReactNode } from "react";

import i18n from "../../i18n";
import Button from "./Button";
import StateMessage from "./StateMessage";
import offlineArt from "../../assets/illustrations/state-offline.svg";

// Pages other than the attendance screens are fetched when opened (owner 2026-09-29), so opening
// one can fail: no connection (web), or a new release replaced the page files. Without this the
// whole screen would crash. With no connection the reader gets a clear message and a retry - the
// attendance screens and the offline queue keep working; after a new release the app reloads once.
const RELOAD_KEY = "prosm_time_page_reload_at";

const isLoadError = (e: unknown) => /dynamically imported module|importing a module script failed|error loading dynamically|ChunkLoadError|Loading chunk/i.test(String((e as Error)?.message ?? e));

interface State {
  failed: boolean;
}

export default class PageLoadBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(error: unknown): State | null {
    if (!isLoadError(error)) throw error;
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (!isLoadError(error) || !navigator.onLine) return;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    } catch {
      /* storage unavailable */
    }
    if (Date.now() - last > 30000) {
      try {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {
        /* storage unavailable */
      }
      window.location.reload();
    }
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const t = (k: string) => i18n.t(k, { ns: "common" }) as string;
    return <StateMessage illustration={offlineArt} title={t("pageLoad.title")} body={t("pageLoad.body")} action={<Button onClick={() => window.location.reload()}>{t("pageLoad.retry")}</Button>} />;
  }
}
