// Owner 2026-10-13 hid Integrations; owner 2026-11-09 turned it back on. The sidebar item
// follows FEATURES.integrations (and, at run time, the plan's integrations flag).
import { describe, expect, it } from "vitest";

import { FEATURES } from "../../config/features";
import { NAV_ITEMS } from "./navigation";

describe("feature switches", () => {
  it("shows Integrations in the sidebar exactly when it is switched on", () => {
    expect(FEATURES.integrations).toBe(true);
    expect(NAV_ITEMS.map((item) => item.id)).toContain("integrations");
    expect(NAV_ITEMS.map((item) => item.id)).toContain("settings");
  });
});
