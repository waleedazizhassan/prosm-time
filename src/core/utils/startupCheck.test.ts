// Owner 2026-10-18: the app must open without internet.
import { afterEach, describe, expect, it, vi } from "vitest";

import { startupCheck } from "./startupCheck";

const setOnline = (value: boolean) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });

describe("startupCheck", () => {
  afterEach(() => {
    setOnline(true);
    vi.useRealTimers();
  });

  it("skips the check at once without a connection", async () => {
    setOnline(false);
    const check = vi.fn(() => Promise.resolve("answer"));
    expect(await startupCheck(check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("gives up on a check that never answers", async () => {
    vi.useFakeTimers();
    const pending = startupCheck(() => new Promise<string>(() => undefined), 6000);
    await vi.advanceTimersByTimeAsync(6001);
    expect(await pending).toBeNull();
  });

  it("returns the answer, and null for a failed check", async () => {
    expect(await startupCheck(() => Promise.resolve("answer"))).toBe("answer");
    expect(await startupCheck(() => Promise.reject(new Error("TypeError: Failed to fetch")))).toBeNull();
  });
});
