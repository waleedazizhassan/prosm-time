// v2.3.43 step 15 (item 18): groups in role order, alphabetical inside,
// one search across groups, "no results".
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
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

let departmentManagersFixture = new Map<string, string[]>();

// the Buzz beside each person reads who is signed in (owner 2026-11-16); signed out here, so it stays hidden
vi.mock("../../core/context/AuthContext", () => ({ useAuth: () => ({ profile: null }) }));

vi.mock("../../core/repositories/PeopleDirectoryRepository", () => ({
  default: {
    status: vi.fn(async () => new Map()),
    list: vi.fn(async () => [
      person("e2", "Zeinab", "employee"),
      person("e1", "Amr", "employee", { presence: "in" }),
      person("v1", "Viewer", "read_only"),
      person("m1", "Mona", "manager"),
      person("o1", "Owner", "owner", { isOwner: true }),
      person("s1", "Sami", "supervisor"),
    ]),
    avatarOf: vi.fn(async () => null),
    // owner 2026-11-16: department managers (none unless a test sets them)
    departmentManagers: vi.fn(async () => departmentManagersFixture),
  },
}));

import PeopleByRole from "./PeopleByRole";

const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

describe("PeopleByRole", () => {
  it("shows the Owner on their own, then managers, supervisors, employees, viewers - names in order (owner 2026-11-13)", async () => {
    const { container } = render(<PeopleByRole />);
    // owner, the (still empty) department managers with where to choose them, managers, supervisors, employees, viewers
    await waitFor(() => expect(container.querySelectorAll("section")).toHaveLength(6));
    const titles = [...container.querySelectorAll("section")].map((section) => (section.querySelector("button, div") as HTMLElement).textContent);
    expect(titles[0]).toContain("1");
    expect(titles[1]).toMatch(/departmentManagers|Department managers/);
    expect(titles[2]).toContain("1");
    const employeeNames = [...container.querySelectorAll("section")[4].querySelectorAll("li")].map((li) => li.textContent ?? "");
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

  it("a department manager is listed under department managers, with the department - and in no other group (owner 2026-11-16)", async () => {
    departmentManagersFixture = new Map([["m1", ["Finance"]]]);
    const { container } = render(<PeopleByRole />);
    await waitFor(() => expect(container.querySelectorAll("section")).toHaveLength(5));
    const sections = [...container.querySelectorAll("section")];
    const titles = sections.map((section) => section.querySelector("button")!.textContent ?? "");
    expect(titles[1]).toMatch(/departmentManagers|Department managers/);
    expect(sections[1].textContent).toContain("Mona");
    expect(sections[1].textContent).toContain("Finance");
    const monaRows = [...container.querySelectorAll("li")].filter((li) => (li.textContent ?? "").includes("Mona"));
    expect(monaRows).toHaveLength(1);
    expect(titles.some((title) => /^Managers|byRole.groups.managers/.test(title))).toBe(false);
    departmentManagersFixture = new Map();
  });
});
