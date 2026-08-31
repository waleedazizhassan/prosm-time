import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import "../../i18n";
import InviteEmployeeModal from "./InviteEmployeeModal";
import EmployeeRepository from "../../core/repositories/EmployeeRepository";

vi.mock("../../core/repositories/EmployeeRepository", () => ({
  default: { inviteUser: vi.fn() },
}));

describe("InviteEmployeeModal", () => {
  beforeEach(() => {
    vi.mocked(EmployeeRepository.inviteUser).mockReset();
  });

  it("submits the invite with the selected role and shows the one-time code on success", async () => {
    vi.mocked(EmployeeRepository.inviteUser).mockResolvedValue({
      success: true,
      message: null,
      data: { userId: "user-1", email: "morgan@acme.example", verificationCode: "123456", expiresAt: "2026-09-07T00:00:00.000Z" },
    });

    render(<InviteEmployeeModal isOpen onClose={() => {}} onInvited={() => {}} />);

    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: "morgan@acme.example" } });
    fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: "Morgan Manager" } });
    fireEvent.change(screen.getByLabelText(/Role/i), { target: { value: "manager" } });
    fireEvent.click(screen.getByRole("button", { name: /Send invitation/i }));

    await waitFor(() => {
      expect(EmployeeRepository.inviteUser).toHaveBeenCalledWith({
        email: "morgan@acme.example",
        fullName: "Morgan Manager",
        roleKey: "manager",
      });
    });

    expect(await screen.findByText("123456")).toBeInTheDocument();
  });

  it("surfaces a real server error instead of the generic one when provided", async () => {
    vi.mocked(EmployeeRepository.inviteUser).mockResolvedValue({
      success: false,
      message: "You do not have permission to invite employees.",
      data: null,
    });

    render(<InviteEmployeeModal isOpen onClose={() => {}} onInvited={() => {}} />);

    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: "morgan@acme.example" } });
    fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: "Morgan Manager" } });
    fireEvent.click(screen.getByRole("button", { name: /Send invitation/i }));

    expect(await screen.findByText("You do not have permission to invite employees.")).toBeInTheDocument();
  });
});
