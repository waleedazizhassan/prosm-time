import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { i18nReady } from "./i18n";
import App from "./App";
import { reloadForNewBuild } from "./core/utils/staleBuild";
import { registerWebServiceWorker } from "./core/utils/webServiceWorker";

// A new web build replaced the files this tab was loaded with: Vite reports
// the failed preload here - reload once to pick up the new build.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewBuild()) event.preventDefault();
});

registerWebServiceWorker();

// Security review 2026-11-12: the host cannot send a frame-blocking header (static hosting), so the app
// refuses to run inside another site's frame (no clicks tricked through an invisible copy).
const framed = (() => {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
})();

const rootElement = framed ? null : document.getElementById("root");
if (framed) {
  document.documentElement.innerHTML = "";
  throw new Error("PROSM Time does not run inside another page.");
}
if (!rootElement) {
  throw new Error("Root element #root not found.");
}

// The first screen appears once the reader's language is loaded (a few KB, not all five languages).
void i18nReady.finally(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
