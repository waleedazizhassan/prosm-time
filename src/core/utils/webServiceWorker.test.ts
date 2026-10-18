// The web service worker runs only in the browser version, in production.
import { describe, expect, it } from "vitest";

import { shouldUseWebServiceWorker } from "./webServiceWorker";

const web = { prod: true, protocol: "https:", native: false, userAgent: "Mozilla/5.0 Chrome", supported: true };

describe("shouldUseWebServiceWorker", () => {
  it("is used by the web version in production", () => {
    expect(shouldUseWebServiceWorker(web)).toBe(true);
  });

  it("is not used by the Android app, the Windows app, development or old browsers", () => {
    expect(shouldUseWebServiceWorker({ ...web, native: true })).toBe(false);
    expect(shouldUseWebServiceWorker({ ...web, protocol: "app:", userAgent: "Mozilla/5.0 Electron/38" })).toBe(false);
    expect(shouldUseWebServiceWorker({ ...web, prod: false })).toBe(false);
    expect(shouldUseWebServiceWorker({ ...web, supported: false })).toBe(false);
  });
});
