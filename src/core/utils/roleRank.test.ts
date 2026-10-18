// Audit 4.4 - the on-behalf list offers only people below the caller.
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
    expect(canActOnBehalfOf(supervisor, employee)).toBe(true);
    expect(canActOnBehalfOf(manager, supervisor)).toBe(true);
    expect(canActOnBehalfOf(manager, owner)).toBe(false);
    expect(canActOnBehalfOf(owner, manager)).toBe(true);
    expect(canActOnBehalfOf(owner, owner)).toBe(false);
  });
});
