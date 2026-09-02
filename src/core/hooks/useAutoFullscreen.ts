import { useEffect } from "react";

const DESKTOP_MIN_WIDTH = 861;

// PROSM Time - § live UX review, user-directed: "opening the app on
// laptop/desktop should go fullscreen like F11 was pressed." Browsers
// refuse Element.requestFullscreen() unless it runs inside a real user
// gesture (click/keydown/touch) - calling it on mount throws and does
// nothing, so a truly automatic fullscreen-on-load is not something
// any web page can do. This is the closest real equivalent: the very
// first interaction anywhere on the page (often within the first
// second - clicking a field, pressing a key) enters fullscreen, then
// the listener removes itself so it never fires again this session.
// Desktop-only (matches AuthLayout's own >=861px breakpoint) - a
// phone browser has no meaningful "fullscreen" in this sense.
export default function useAutoFullscreen() {
  useEffect(() => {
    if (window.innerWidth < DESKTOP_MIN_WIDTH) return undefined;
    if (!document.fullscreenEnabled) return undefined;

    const enterFullscreen = () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {
          // Ignored - e.g. the user already exited fullscreen once this
          // session and the browser is now refusing to re-enter it, or
          // it's blocked by a permissions policy. Nothing to recover.
        });
      }
      document.removeEventListener("pointerdown", enterFullscreen);
      document.removeEventListener("keydown", enterFullscreen);
    };

    document.addEventListener("pointerdown", enterFullscreen, { once: true });
    document.addEventListener("keydown", enterFullscreen, { once: true });

    return () => {
      document.removeEventListener("pointerdown", enterFullscreen);
      document.removeEventListener("keydown", enterFullscreen);
    };
  }, []);
}
