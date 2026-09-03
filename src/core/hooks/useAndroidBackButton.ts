import { useEffect } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

// PROSM Time - § live UX review, user-directed: "the phone's back
// button exits the app instead of navigating between pages." Capacitor's
// default Android behavior calls exitApp() the instant the WebView has
// no more history entries - which happens on every deep link/first
// screen even though the user is still deep in the app's own React
// Router state. canGoBack is computed by the native bridge itself from
// the WebView's real history, and window.history.back() already
// integrates with BrowserRouter (which listens for popstate) - so no
// app-specific routing logic is needed here, only the native listener.
// Native-only: Capacitor.isNativePlatform() is false in every browser
// this app also runs in, so this is a no-op there.
export default function useAndroidBackButton() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;

    const listenerPromise = CapacitorApp.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack) window.history.back();
      else CapacitorApp.exitApp();
    });

    return () => {
      listenerPromise.then((listener) => listener.remove());
    };
  }, []);
}
