import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, Outlet } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AppRoutes from "./AppRoutes";
import AuthService from "../core/auth/AuthService";
import { getLockedKioskSite, lockKiosk, unlockKiosk } from "../modules/kiosk/kioskLock";

// Audit 1.3 - the kiosk must not offer the signed-in person's app shell.
// The shell is replaced by a stand-in with a menu link so the test sees
// whether the kiosk is rendered inside it.
vi.mock("../layouts/AppShell", () => ({
  default: () => (
    <div>
      <nav>
        <Link to="/people">People</Link>
      </nav>
      <Outlet />
    </div>
  ),
}));
vi.mock("../layouts/AppShell/UpdateAvailableBanner", () => ({ default: () => null }));
vi.mock("../modules/kiosk/KioskPage", () => ({ default: () => <p>kiosk-screen</p> }));
vi.mock("../modules/kiosk/KioskLauncherPage", () => ({ default: () => <p>kiosk-launcher</p> }));
vi.mock("../modules/people/PeoplePage", () => ({ default: () => <p>people-page</p> }));
vi.mock("../modules/activation/useTrialStatus", () => ({ default: () => ({ loading: false, status: null, reload: vi.fn() }) }));
vi.mock("../core/auth/AuthService", () => ({ default: { signIn: vi.fn() } }));
// The privacy acknowledgement is already given (tested in modules/legal).
vi.mock("../core/repositories/LegalRepository", () => ({
  default: { hasAcknowledged: () => Promise.resolve({ success: true, message: null, data: true }), acknowledge: vi.fn() },
}));
vi.mock("../core/context/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    loading: false,
    isAuthenticated: true,
    profile: { id: "u1", organizationId: "o1", email: "owner@acme.example", fullName: "Owner", status: "active", isOwner: true, roleKey: "owner", roleName: "Owner", avatarUrl: null },
    permissions: [],
    hasPermission: () => true,
    refreshProfile: vi.fn(),
    signOut: vi.fn(),
  }),
}));

function openAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<AppRoutes />);
}

describe("kiosk lock (audit 1.3)", () => {
  beforeEach(() => {
    unlockKiosk();
    vi.mocked(AuthService.signIn).mockReset();
  });
  afterEach(() => unlockKiosk());

  it("shows the kiosk with no app navigation", async () => {
    openAt("/kiosk/site-1");
    expect(await screen.findByText("kiosk-screen")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("link", { name: "People" })).toBeNull();
    await waitFor(() => expect(getLockedKioskSite()).toBe("site-1"));
  });

  it("sends any other address back to the locked kiosk", async () => {
    lockKiosk("site-1");
    openAt("/people");
    expect(await screen.findByText("kiosk-screen")).toBeInTheDocument();
    expect(screen.queryByText("people-page")).toBeNull();
    expect(window.location.pathname).toBe("/kiosk/site-1");
  });

  it("stays locked on a wrong password and leaves with the right one", async () => {
    openAt("/kiosk/site-1");
    fireEvent.click(await screen.findByRole("button", { name: /Exit kiosk/i }));
    const password = screen.getByLabelText(/Password/i, { selector: "input" });

    vi.mocked(AuthService.signIn).mockResolvedValueOnce({ success: false, message: "Invalid login credentials", data: null });
    fireEvent.change(password, { target: { value: "wrong" } });
    fireEvent.click(screen.getAllByRole("button", { name: /Exit kiosk/i }).at(-1)!);
    expect(await screen.findByText("Wrong password.")).toBeInTheDocument();
    expect(getLockedKioskSite()).toBe("site-1");

    vi.mocked(AuthService.signIn).mockResolvedValueOnce({ success: true, message: null, data: null });
    fireEvent.change(password, { target: { value: "right" } });
    fireEvent.click(screen.getAllByRole("button", { name: /Exit kiosk/i }).at(-1)!);
    expect(await screen.findByText("kiosk-launcher")).toBeInTheDocument();
    expect(AuthService.signIn).toHaveBeenLastCalledWith("owner@acme.example", "right");
    expect(getLockedKioskSite()).toBeNull();
  });
});
