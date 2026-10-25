// v2.3.43 step 15 (item 18): groups in role order, alphabetical inside,
// one search across groups, "no results".
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DirectoryPerson } from "../../core/repositories/PeopleDirectoryRepository";

const person = (id: string, fullName: string, roleKey: string, extra: Partial<DirectoryPerson> = {}): DirectoryPerson => ({
  id,
  fullName,
  email: `${id}@x.test`,
  avatarUrl: null,
  isOwner: false,
  isActive: true,
  roleKey,
  roleName: roleKey,
  roleSort: 40,
  siteIds: ["s1"],
  siteNames: ["Plant"],
  presence: "out",
  clockInAt: null,
  currentSiteName: null,
  shiftStart: null,
  shiftEnd: null,
  ...extra,
});

vi.mock("../../core/repositories/PeopleDirectoryRepository", () => ({
  default: {
    list: vi.fn(async () => [
      person("e2", "Zeinab", "employee"),
      person("e1", "Amr", "employee", { presence: "in" }),
      person("v1", "Viewer", "read_only"),
      person("m1", "Mona", "manager"),
      person("o1", "Owner", "owner", { isOwner: true }),
      person("s1", "Sami", "supervisor"),
    ]),
    avatarOf: vi.fn(async () => null),
  },
}));

import PeopleByRole from "./PeopleByRole";

describe("PeopleByRole", () => {
  it("shows managers (with the Owner), supervisors, employees, viewers - names in order", async () => {
    const { container } = render(<PeopleByRole />);
    await waitFor(() => expect(container.querySelectorAll("section")).toHaveLength(4));
    const titles = [...container.querySelectorAll("section")].map((section) => section.querySelector("button")!.textContent);
    expect(titles[0]).toContain("2");
    const employeeNames = [...container.querySelectorAll("section")[2].querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(employeeNames[0]).toContain("Amr");
    expect(employeeNames[1]).toContain("Zeinab");
  });

  it("searches across every group and says when nobody matches", async () => {
    const { container } = render(<PeopleByRole />);
    await waitFor(() => expect(container.querySelectorAll("section").length).toBeGreaterThan(0));
    fireEvent.change(container.querySelector("input[name=peopleSearch]")!, { target: { value: "mon" } });
    expect(container.querySelectorAll("li")).toHaveLength(1);
    fireEvent.change(container.querySelector("input[name=peopleSearch]")!, { target: { value: "nobody" } });
    expect(container.querySelectorAll("section")).toHaveLength(0);
    expect(screen.getByText(/byRole.noResults|No one matches/)).toBeTruthy();
  });
});
