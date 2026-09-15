import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";

import "../../i18n";
import ActivationPage from "./ActivationPage";
import ActivationRepository from "../../core/repositories/ActivationRepository";
import AuthService from "../../core/auth/AuthService";

vi.mock("../../core/repositories/ActivationRepository", () => ({
  default: { activateOrganization: vi.fn() },
}));

vi.mock("../../core/auth/AuthService", () => ({
  default: { signIn: vi.fn() },
}));

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/Activation code/i), { target: { value: "PMTIME-ABCD-1234-EFGH" } });
  fireEvent.change(screen.getByLabelText(/Organization name/i), { target: { value: "Acme Field Services" } });
  fireEvent.change(screen.getByLabelText(/Your full name/i), { target: { value: "Jordan Rivera" } });
  fireEvent.change(screen.getByLabelText(/Your email/i), { target: { value: "owner@acme.example" } });
  fireEvent.change(screen.getByLabelText(/Choose a password/i), { target: { value: "SuperSecret123" } });
  fireEvent.change(screen.getByLabelText(/Confirm password/i, { selector: "input" }), { target: { value: "SuperSecret123" } });
  fireEvent.click(screen.getByLabelText(/I understand and agree/i));
  fireEvent.click(screen.getByRole("button", { name: /^Activate$/i }));
}

describe("ActivationPage", () => {
  beforeEach(() => {
    vi.mocked(ActivationRepository.activateOrganization).mockReset();
    vi.mocked(AuthService.signIn).mockReset();
  });

  it("submits trimmed activation input to ActivationRepository", async () => {
    vi.mocked(ActivationRepository.activateOrganization).mockResolvedValue({
      success: true,
      message: null,
      data: { organizationId: "org-1", userId: "user-1", licenseNumber: "PMTIME-LIC-XXXX" },
    });
    vi.mocked(AuthService.signIn).mockResolvedValue({ success: true, message: null, data: null });

    render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>
    );

    fillAndSubmit();

    await waitFor(() => {
      expect(ActivationRepository.activateOrganization).toHaveBeenCalledWith({
        activationCode: "PMTIME-ABCD-1234-EFGH",
        organizationName: "Acme Field Services",
        ownerEmail: "owner@acme.example",
        ownerPassword: "SuperSecret123",
        ownerFullName: "Jordan Rivera",
      });
    });
  });

  it("shows the real server error message on failure, not a generic one when provided", async () => {
    // A real raw backend code (compute_prosm_time_geofence_check's own
    // sibling RPCs raise this literal string - see
    // supabase/migrations/20260831110000_wp03_organizations_and_auth.sql)
    // - humanizeBackendError translates it, this is no longer the raw
    // ALL-CAPS text reaching the UI verbatim.
    vi.mocked(ActivationRepository.activateOrganization).mockResolvedValue({
      success: false,
      message: "INVALID LICENSE STATUS",
      data: null,
    });

    render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>
    );

    fillAndSubmit();

    expect(await screen.findByText("This license status isn't valid.")).toBeInTheDocument();
    expect(AuthService.signIn).not.toHaveBeenCalled();
  });
});
