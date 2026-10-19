import { Component, type ReactNode } from "react";

import i18n from "../../i18n";
import Button from "./Button";
import { isStaleBuildError, reloadForNewBuild, retryPageLoad } from "../../core/utils/staleBuild";
import StateMessage from "./StateMessage";
import offlineArt from "../../assets/illustrations/state-offline.svg";

// Pages other than the attendance screens are fetched when opened (owner 2026-09-29), so opening
// one can fail: no connection (web), a new release replaced the page files, or the web host
// answered with the wrong file. Without this the whole screen would crash. The app first reloads
// on its own (a few times); if the page still can't be loaded the reader gets a message and a
// retry - "no connection" only when the device is really offline (owner 2026-10-19: it said so
// with the internet on). The attendance screens and the offline queue keep working either way.

interface State {
  failed: boolean;
}

export default class PageLoadBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(error: unknown): State | null {
    if (!isStaleBuildError(error)) throw error;
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (isStaleBuildError(error)) reloadForNewBuild();
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const t = (k: string) => i18n.t(k, { ns: "common" }) as string;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    const key = offline ? "pageLoad" : "pageLoad.server";
    return <StateMessage illustration={offlineArt} title={t(`${key}.title`)} body={t(`${key}.body`)} action={<Button onClick={retryPageLoad}>{t("pageLoad.retry")}</Button>} />;
  }
}
