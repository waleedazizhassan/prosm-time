// Owner 2026-10-13: integrations are hidden (not deleted) while
// FEATURES.integrations is off.
import { describe, expect, it } from "vitest";

import { FEATURES } from "../../config/features";
import { NAV_ITEMS } from "./navigation";

describe("hidden features", () => {
  it("keeps Integrations out of the sidebar and the search while it is off", () => {
    expect(FEATURES.integrations).toBe(false);
    expect(NAV_ITEMS.map((item) => item.id)).not.toContain("integrations");
    expect(NAV_ITEMS.map((item) => item.id)).toContain("settings");
  });
});
