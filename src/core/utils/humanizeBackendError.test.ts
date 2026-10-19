// Audit 4.1 - a wrong kiosk PIN or an unknown worker number must show a
// clear message, not "Unable to complete this action."
import { describe, expect, it } from "vitest";

import i18n from "../../i18n";
import humanizeBackendError from "./humanizeBackendError";

describe("humanizeBackendError", () => {
  const t = i18n.getFixedT("en");

  it("maps a wrong kiosk PIN inside the server's wrapper", () => {
    expect(humanizeBackendError("KIOSK CLOCK IN FAILED: INCORRECT PIN", t)).toBe(t("common:backendErrors.incorrectPin"));
  });

  it("maps an unknown worker number", () => {
    expect(humanizeBackendError("KIOSK WORKER CLOCK IN FAILED: NO WORKER WITH THIS NUMBER", t)).toBe("This number is not registered.");
  });

  it("maps the attempt limit", () => {
    expect(humanizeBackendError("Too many attempts. Please wait a few minutes and try again.", t)).toBe(t("common:backendErrors.tooManyAttempts"));
  });

  it("turns a request that never reached the server into a kind message", () => {
    expect(humanizeBackendError("TypeError: Failed to fetch", t)).toBe(t("common:backendErrors.networkProblem"));
    expect(humanizeBackendError("Failed to send a request to the Edge Function", t)).toBe(t("common:backendErrors.networkProblem"));
  });

  it("keeps exact messages working and leaves unexpected ones to the generic text", () => {
    expect(humanizeBackendError("INCORRECT PIN", t)).toBe(t("common:backendErrors.incorrectPin"));
    expect(humanizeBackendError("CLOCK IN FAILED: relation does not exist", t)).toBeNull();
  });
});
