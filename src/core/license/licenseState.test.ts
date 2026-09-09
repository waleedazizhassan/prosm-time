import { describe, expect, it } from "vitest";

import { licenseNotice, toLicenseSnapshot, UNKNOWN_LICENSE } from "./licenseState";

describe("license state mapping", () => {
  it("keeps a licensed installation silent", () => {
    const snapshot = toLicenseSnapshot({ state: "LICENSED", identified: true, allowed: true });
    expect(snapshot.allowed).toBe(true);
    expect(licenseNotice(snapshot)).toBeNull();
  });

  it("shows the remaining grace days for an unlicensed installation", () => {
    const snapshot = toLicenseSnapshot({
      state: "GRACE",
      identified: true,
      allowed: true,
      graceDaysRemaining: 27,
      graceEndsAt: "2026-10-06T00:00:00Z",
    });
    const notice = licenseNotice(snapshot);
    expect(notice?.tone).toBe("warning");
    expect(notice?.messageKey).toBe("notice.grace");
    expect(notice?.daysRemaining).toBe(27);
    expect(notice?.actionKey).toBe("action.activate");
  });

  it("treats an expired grace period as a critical, blocking state", () => {
    const snapshot = toLicenseSnapshot({ state: "EXPIRED", identified: true, allowed: false });
    expect(snapshot.allowed).toBe(false);
    expect(licenseNotice(snapshot)?.tone).toBe("critical");
  });

  it.each(["SUSPENDED", "BLOCKED", "REVOKED"])("routes %s to support, not to self-activation", (state) => {
    const notice = licenseNotice(toLicenseSnapshot({ state, allowed: false }));
    expect(notice?.tone).toBe("critical");
    expect(notice?.actionKey).toBe("action.support");
  });

  it("never invents a state from a malformed or hostile payload", () => {
    const snapshot = toLicenseSnapshot({ state: "TOTALLY_LICENSED_TRUST_ME", allowed: true });
    expect(snapshot.state).toBe("UNKNOWN");
    expect(licenseNotice(snapshot)).toBeNull();
  });

  it("negative grace days are clamped to zero", () => {
    expect(toLicenseSnapshot({ state: "GRACE", graceDaysRemaining: -5 }).graceDaysRemaining).toBe(0);
  });

  it("an unreachable server leaves the state unknown and stale", () => {
    expect(UNKNOWN_LICENSE.state).toBe("UNKNOWN");
    expect(UNKNOWN_LICENSE.stale).toBe(true);
    expect(licenseNotice(UNKNOWN_LICENSE)).toBeNull();
  });
});
