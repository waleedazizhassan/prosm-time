// Audit 4.4 - the on-behalf list offers only people below the caller,
// and only to the Owner or a Manager (owner 2026-10-19).
import { describe, expect, it } from "vitest";

import { canActOnBehalfOf } from "./roleRank";

const owner = { isOwner: true, roleKey: "owner" };
const manager = { isOwner: false, roleKey: "manager" };
const supervisor = { isOwner: false, roleKey: "supervisor" };
const employee = { isOwner: false, roleKey: "employee" };

describe("canActOnBehalfOf", () => {
  it("follows owner > manager > supervisor > employee", () => {
    expect(canActOnBehalfOf(supervisor, manager)).toBe(false);
    expect(canActOnBehalfOf(supervisor, supervisor)).toBe(false);
    // Owner 2026-10-19: only the Owner or a Manager acts on someone's behalf.
    expect(canActOnBehalfOf(supervisor, employee)).toBe(false);
    expect(canActOnBehalfOf(manager, employee)).toBe(true);
    // Never on one's own behalf (owner 2026-10-19).
    expect(canActOnBehalfOf(manager, manager)).toBe(false);
    expect(canActOnBehalfOf(manager, supervisor)).toBe(true);
    expect(canActOnBehalfOf(manager, owner)).toBe(false);
    expect(canActOnBehalfOf(owner, manager)).toBe(true);
    expect(canActOnBehalfOf(owner, owner)).toBe(false);
  });
});
