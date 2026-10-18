// Owner 2026-10-18: "the app doesn't open offline". A person signed in on
// this device must get into the app without a connection, on the saved
// session and profile, even when the session can't be renewed.
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AuthService from "../auth/AuthService";
import { AuthProvider, useAuth } from "./AuthContext";

vi.mock("../auth/AuthService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/AuthService")>();
  return {
    default: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      hasStoredSession: actual.default.hasStoredSession.bind(actual.default),
      signOut: vi.fn(),
    },
  };
});
vi.mock("../repositories/UserRepository", () => ({ default: { getCurrentUser: vi.fn(() => new Promise(() => undefined)) } }));
vi.mock("../repositories/PermissionRepository", () => ({ default: { getEffectivePermissions: vi.fn(() => new Promise(() => undefined)) } }));

const setOnline = (value: boolean) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });

function Probe() {
  const { loading, isAuthenticated, profile } = useAuth();
  return <p>{loading ? "loading" : isAuthenticated ? `in:${profile?.fullName}` : "signed-out"}</p>;
}

const saveSignedInDevice = () => {
  localStorage.setItem("prosm_time_cached_profile_v1", JSON.stringify({ profile: { id: "u1", fullName: "Omar Hassan", isOwner: false }, permissions: [] }));
  localStorage.setItem("sb-project-auth-token", JSON.stringify({ access_token: "expired", refresh_token: "r1" }));
};

describe("opening the app without internet", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(AuthService.getSession).mockReset();
  });
  afterEach(() => {
    setOnline(true);
    vi.useRealTimers();
  });

  it("opens at once on the saved session and profile while offline", async () => {
    setOnline(false);
    saveSignedInDevice();
    vi.mocked(AuthService.getSession).mockResolvedValue(null);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(await screen.findByText("in:Omar Hassan")).toBeInTheDocument();
    expect(localStorage.getItem("prosm_time_cached_profile_v1")).not.toBeNull();
  });

  it("opens after the time limit when the session check never answers", async () => {
    vi.useFakeTimers();
    saveSignedInDevice();
    vi.mocked(AuthService.getSession).mockReturnValue(new Promise(() => undefined));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByText("loading")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(screen.getByText("in:Omar Hassan")).toBeInTheDocument();
  });

  it("still shows sign-in for someone never signed in on this device", async () => {
    setOnline(false);
    vi.mocked(AuthService.getSession).mockResolvedValue(null);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(await screen.findByText("signed-out")).toBeInTheDocument();
  });
});
