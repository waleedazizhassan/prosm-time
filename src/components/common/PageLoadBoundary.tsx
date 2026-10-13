import { Component, type ReactNode } from "react";

import i18n from "../../i18n";
import Button from "./Button";
import { isStaleBuildError, reloadForNewBuild } from "../../core/utils/staleBuild";
import StateMessage from "./StateMessage";
import offlineArt from "../../assets/illustrations/state-offline.svg";

// Pages other than the attendance screens are fetched when opened (owner 2026-09-29), so opening
// one can fail: no connection (web), or a new release replaced the page files. Without this the
// whole screen would crash. With no connection the reader gets a clear message and a retry - the
// attendance screens and the offline queue keep working; after a new release the app reloads once.

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
    return <StateMessage illustration={offlineArt} title={t("pageLoad.title")} body={t("pageLoad.body")} action={<Button onClick={() => window.location.reload()}>{t("pageLoad.retry")}</Button>} />;
  }
}
