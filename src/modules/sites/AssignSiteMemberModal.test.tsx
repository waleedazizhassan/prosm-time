// Audit 4.3 - assigning a Manager to a site defaults their site role to
// "Site manager", not "Member".
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AssignSiteMemberModal, { defaultSiteRole } from "./AssignSiteMemberModal";
import SiteRepository from "../../core/repositories/SiteRepository";

vi.mock("../../core/context/AuthContext", () => ({
  useAuth: () => ({ profile: { id: "owner", isOwner: true } }),
}));
vi.mock("../../core/repositories/EmployeeRepository", () => ({
  default: {
    listOrganizationMembers: () =>
      Promise.resolve({
        success: true,
        message: null,
        data: [
          { id: "u-emp", email: "emp@acme.example", fullName: "Omar Employee", status: "active", isOwner: false, isActive: true, roleKey: "employee" },
          { id: "u-mgr", email: "mgr@acme.example", fullName: "Mona Manager", status: "active", isOwner: false, isActive: true, roleKey: "manager" },
        ],
      }),
  },
}));
vi.mock("../../core/repositories/SiteRepository", () => ({
  default: { setSiteAssignment: vi.fn(() => Promise.resolve({ success: true, message: null, data: null })) },
}));

describe("site role default (audit 4.3)", () => {
  it("maps organisation roles to site roles", () => {
    expect(defaultSiteRole("manager")).toBe("manager");
    expect(defaultSiteRole("supervisor")).toBe("manager");
    expect(defaultSiteRole("employee")).toBe("member");
    expect(defaultSiteRole("read_only")).toBe("member");
  });

  it("assigns a Manager as site manager without changing the role by hand", async () => {
    render(<AssignSiteMemberModal isOpen onClose={vi.fn()} onAssigned={vi.fn()} siteId="site-1" />);
    // the person list is the app's own drop-down (owner 2026-10-26)
    const person = await waitFor(() => document.querySelector<HTMLElement>('[aria-haspopup="listbox"]')!);
    fireEvent.click(person);
    fireEvent.click(await screen.findByRole("option", { name: /Mona Manager/ }));
    fireEvent.click(screen.getByRole("button", { name: /Assign/i }));
    await waitFor(() => expect(SiteRepository.setSiteAssignment).toHaveBeenCalledWith("site-1", "u-mgr", "manager"));
  });
});
