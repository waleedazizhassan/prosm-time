// A file of the previous build after a new release is recognised in every
// browser's wording, including prosm.net's HTML answer for a missing file.
import { afterEach, describe, expect, it, vi } from "vitest";

import { isStaleBuildError, MAX_RELOADS, reloadForNewBuild, retryPageLoad } from "./staleBuild";

describe("isStaleBuildError", () => {
  it("recognises a missing file of the previous build", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://prosm.net/time-app/assets/SitesPage-abc.js",
      "error loading dynamically imported module: https://prosm.net/time-app/assets/SitesPage-abc.js",
      "Importing a module script failed.",
      'Loading module from "https://prosm.net/time-app/assets/SitesPage-abc.js" was blocked because of a disallowed MIME type ("text/html").',
      'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".',
      "Unable to preload CSS for /time-app/assets/x.css",
    ]) {
      expect(isStaleBuildError(new Error(message))).toBe(true);
    }
  });

  it("leaves real errors to the error screen", () => {
    expect(isStaleBuildError(new TypeError("Cannot read properties of undefined (reading 'name')"))).toBe(false);
  });
});

// Owner 2026-10-19: the host sometimes answers an existing file with the
// HTML page, so one reload is not always enough.
describe("reloadForNewBuild", () => {
  const reload = vi.fn();
  afterEach(() => {
    sessionStorage.clear();
    reload.mockReset();
    vi.unstubAllGlobals();
  });
  const stubLocation = () => {
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
  };

  it("reloads a few times, then stops so the reader sees the message", () => {
    stubLocation();
    for (let i = 0; i < MAX_RELOADS; i += 1) expect(reloadForNewBuild()).toBe(true);
    expect(reloadForNewBuild()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(MAX_RELOADS);
  });

  it("never reloads offline, and Try again starts a fresh round", () => {
    stubLocation();
    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    expect(reloadForNewBuild()).toBe(false);
    vi.unstubAllGlobals();
    for (let i = 0; i < MAX_RELOADS; i += 1) reloadForNewBuild();
    retryPageLoad();
    expect(reloadForNewBuild()).toBe(true);
  });
});
