// Owner 2026-10-18/20: push notifications (where a tap leads: src/core/utils/notificationTarget.test.ts).
import { describe, expect, it } from "vitest";

import { isPushSupported } from "./PushService";

describe("push notifications", () => {
  it("stays off outside an Android build made with Firebase", () => {
    expect(isPushSupported()).toBe(false);
  });
});
