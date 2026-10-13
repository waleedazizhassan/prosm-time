// A file of the previous build after a new release is recognised in every
// browser's wording, including prosm.net's HTML answer for a missing file.
import { describe, expect, it } from "vitest";

import { isStaleBuildError } from "./staleBuild";

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
