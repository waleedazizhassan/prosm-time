// v2.3.43 step 19 (item 13): a tracking failure is told apart - a refused
// location permission (open the settings) or the service not starting
// (tried again) - instead of being swallowed.
import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({ registerPlugin: () => ({}), Capacitor: { isNativePlatform: () => false } }));

import { trackingFailureOf } from "./BackgroundLocationService";

describe("trackingFailureOf", () => {
  it("knows a refused permission", () => {
    expect(trackingFailureOf(Object.assign(new Error("Permission denied."), { code: "NOT_AUTHORIZED" }))).toBe("permission");
    expect(trackingFailureOf(new Error("User denied location permission"))).toBe("permission");
  });

  it("treats anything else as the service failing", () => {
    expect(trackingFailureOf(new Error("Location services disabled"))).toBe("failed");
    expect(trackingFailureOf("boom")).toBe("failed");
  });
});
