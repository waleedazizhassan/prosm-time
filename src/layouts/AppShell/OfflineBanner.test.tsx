// Owner 2026-10-13 - kind offline / back-online messages with pictures.
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import OfflineBanner from "./OfflineBanner";

const setOnline = (value: boolean) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });

describe("OfflineBanner", () => {
  afterEach(() => {
    setOnline(true);
    vi.useRealTimers();
  });

  it("says attendance still works while offline, then briefly says the connection is back", () => {
    vi.useFakeTimers();
    setOnline(true);
    render(<OfflineBanner />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText("You're offline")).toBeInTheDocument();
    expect(screen.getByText(/clock in, clock out and breaks still work/)).toBeInTheDocument();
    expect(screen.getByRole("status").querySelector("img")).not.toBeNull();

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByText(/You're back online/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4500);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
