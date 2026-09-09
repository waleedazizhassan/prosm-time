import { describe, expect, it, beforeEach } from "vitest";

import {
  compareVersions,
  evaluateUpdate,
  isSnoozed,
  parseManifest,
  snoozeUpdate,
} from "./updateChannel";

describe("compareVersions", () => {
  it("orders releases numerically, not lexically", () => {
    expect(compareVersions("2.10.0", "2.9.0")).toBe(1);
    expect(compareVersions("2.3.0", "2.3.0")).toBe(0);
    expect(compareVersions("v2.3.1", "2.4.0")).toBe(-1);
  });
});

describe("parseManifest", () => {
  it("accepts a well formed manifest", () => {
    const manifest = parseManifest({
      version: "2.4.0",
      releasedAt: "2026-09-09T10:00:00Z",
      notes: "Security and performance updates.",
      security: true,
      downloads: { android: "https://example.com/apk", windows: "https://example.com/exe" },
    });
    expect(manifest?.version).toBe("2.4.0");
    expect(manifest?.security).toBe(true);
    expect(manifest?.downloads.android).toBe("https://example.com/apk");
  });

  it("rejects malformed payloads instead of guessing", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest({ version: "latest" })).toBeNull();
    expect(parseManifest("2.4.0")).toBeNull();
  });

  it("drops non-https download links", () => {
    const manifest = parseManifest({
      version: "2.4.0",
      downloads: { android: "http://insecure.example/apk", windows: "javascript:alert(1)" },
    });
    expect(manifest?.downloads.android).toBeUndefined();
    expect(manifest?.downloads.windows).toBeUndefined();
  });
});

describe("evaluateUpdate", () => {
  const manifest = parseManifest({
    version: "2.4.0",
    downloads: { android: "https://example.com/apk", windows: "https://example.com/exe" },
  });

  it("reports nothing when the installed version is current or newer", () => {
    expect(evaluateUpdate(manifest, "2.4.0", "web")).toBeNull();
    expect(evaluateUpdate(manifest, "2.5.0", "web")).toBeNull();
    expect(evaluateUpdate(null, "2.3.0", "web")).toBeNull();
  });

  it("reports a newer release with the right download path per platform", () => {
    expect(evaluateUpdate(manifest, "2.3.0", "web")).toMatchObject({
      currentVersion: "2.3.0",
      newVersion: "2.4.0",
      downloadUrl: null,
    });
    expect(evaluateUpdate(manifest, "2.3.0", "android")?.downloadUrl).toBe("https://example.com/apk");
    expect(evaluateUpdate(manifest, "2.3.0", "windows")?.downloadUrl).toBe("https://example.com/exe");
  });
});

describe("snoozing", () => {
  beforeEach(() => window.localStorage.clear());

  it("hides a dismissed version for a day and a security release for an hour", () => {
    const now = Date.now();
    snoozeUpdate("2.4.0", false, now);
    expect(isSnoozed("2.4.0", now + 60_000)).toBe(true);
    expect(isSnoozed("2.4.0", now + 25 * 60 * 60 * 1000)).toBe(false);
    expect(isSnoozed("2.5.0", now + 60_000)).toBe(false);

    snoozeUpdate("2.6.0", true, now);
    expect(isSnoozed("2.6.0", now + 30 * 60 * 1000)).toBe(true);
    expect(isSnoozed("2.6.0", now + 2 * 60 * 60 * 1000)).toBe(false);
  });
});
