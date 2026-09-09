import { useEffect } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

import AuthService from "../auth/AuthService";

// PROSM Time - § real bug, user-reported: the mobile app randomly
// signs itself out, forcing a fresh login. supabase-js's own
// autoRefreshToken timer cannot fire while Android suspends the
// WebView's JS execution during backgrounding - if the access token
// expires during that window, the app looks signed-out on return even
// though the refresh token on disk is still valid. This forces an
// explicit refresh attempt the moment the app becomes active again,
// closing that window instead of relying on the background timer
// alone. AuthService.refreshSession() updates the client's own
// session state, which fires the existing onAuthStateChange listener
// in AuthContext.tsx - no separate state plumbing needed here.
//
// Covers both native (Capacitor's own appStateChange event) and the
// web build (the page's visibilitychange event, for the same class of
// issue on a mobile browser tab backgrounded for a long time) - a
// no-op on desktop where this basically never triggers in practice.
export default function useSessionResume() {
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      const listenerPromise = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) AuthService.refreshSession();
      });
      return () => {
        listenerPromise.then((listener) => listener.remove());
      };
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") AuthService.refreshSession();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);
}
