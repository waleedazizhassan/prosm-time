import { Capacitor } from "@capacitor/core";

// Web version only (owner 2026-10-18: "the app doesn't open offline"):
// public/sw.js keeps the app's files on the device. The Android and Windows
// apps already carry their own files, so they don't use it.
export function shouldUseWebServiceWorker(env: { prod: boolean; protocol: string; native: boolean; userAgent: string; supported: boolean }): boolean {
  return env.prod && env.supported && /^https?:$/.test(env.protocol) && !env.native && !/Electron/i.test(env.userAgent);
}

export function registerWebServiceWorker(): void {
  const use = shouldUseWebServiceWorker({
    prod: import.meta.env.PROD,
    protocol: window.location.protocol,
    native: Capacitor.isNativePlatform(),
    userAgent: navigator.userAgent,
    supported: "serviceWorker" in navigator,
  });
  if (!use) return;
  // sw.js sits next to index.html, one level above this file's assets/ folder - whatever base path the site uses.
  const url = new URL("../sw.js", import.meta.url);
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(url, { scope: new URL("./", url).pathname }).catch(() => undefined);
  });
}
