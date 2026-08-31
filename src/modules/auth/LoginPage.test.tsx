import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";

import "../../i18n";
import LoginPage from "./LoginPage";
import AuthService from "../../core/auth/AuthService";
import { useAuth } from "../../core/context/AuthContext";

vi.mock("../../core/auth/AuthService", () => ({
  default: { signIn: vi.fn() },
}));

vi.mock("../../core/context/AuthContext", () => ({
  useAuth: vi.fn(),
}));

describe("LoginPage", () => {
  beforeEach(() => {
    vi.mocked(AuthService.signIn).mockReset();
    vi.mocked(useAuth).mockReturnValue({
      loading: false,
      isAuthenticated: false,
      profile: null,
      refreshProfile: vi.fn(),
      signOut: vi.fn(),
    });
  });

  it("calls AuthService.signIn with the entered credentials", async () => {
    vi.mocked(AuthService.signIn).mockResolvedValue({ success: true, message: null, data: null });

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: "owner@acme.example" } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: "SuperSecret123" } });
    fireEvent.click(screen.getByRole("button", { name: /Sign in/i }));

    await waitFor(() => {
      expect(AuthService.signIn).toHaveBeenCalledWith("owner@acme.example", "SuperSecret123");
    });
  });

  it("surfaces a real sign-in error", async () => {
    vi.mocked(AuthService.signIn).mockResolvedValue({ success: false, message: "Invalid login credentials.", data: null });

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: "owner@acme.example" } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /Sign in/i }));

    expect(await screen.findByText("Invalid login credentials.")).toBeInTheDocument();
  });
});
