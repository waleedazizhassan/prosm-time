import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import "../../i18n";
import AcceptInvitationPage from "./AcceptInvitationPage";
import InvitationRepository from "../../core/repositories/InvitationRepository";
import AuthService from "../../core/auth/AuthService";

vi.mock("../../core/repositories/InvitationRepository", () => ({
  default: { redeemInvitation: vi.fn() },
}));

vi.mock("../../core/auth/AuthService", () => ({
  default: { signIn: vi.fn() },
}));

// Regression coverage for the invitation-link gap: InviteEmployeeModal
// shares a /accept-invitation?email=&code= link, so both fields must
// arrive pre-filled from the URL - the employee should never have to
// type either by hand.
describe("AcceptInvitationPage", () => {
  it("pre-fills email and verification code from the invitation link", () => {
    vi.mocked(InvitationRepository.redeemInvitation);
    vi.mocked(AuthService.signIn);

    render(
      <MemoryRouter initialEntries={["/accept-invitation?email=morgan%40acme.example&code=123456"]}>
        <AcceptInvitationPage />
      </MemoryRouter>
    );

    expect(screen.getByLabelText(/Email/i)).toHaveValue("morgan@acme.example");
    expect(screen.getByLabelText(/verification code/i)).toHaveValue("123456");
  });

  it("leaves both fields empty when no invitation link parameters are present", () => {
    render(
      <MemoryRouter initialEntries={["/accept-invitation"]}>
        <AcceptInvitationPage />
      </MemoryRouter>
    );

    expect(screen.getByLabelText(/Email/i)).toHaveValue("");
    expect(screen.getByLabelText(/verification code/i)).toHaveValue("");
  });
});
