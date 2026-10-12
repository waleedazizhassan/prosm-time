// Audit 1.2 - "my" lists must filter on the caller's own user id, not
// rely on RLS (which lets owners and managers read other people's rows).
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];

function queryBuilder(table: string) {
  const entry = { table, filters: [] as Array<[string, unknown]> };
  calls.push(entry);
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      entry.filters.push([column, value]);
      return builder;
    },
    order: () => Promise.resolve({ data: [], error: null }),
  };
  return builder;
}

vi.mock("../database/DatabaseManager", () => ({
  default: { getClient: () => ({ from: (table: string) => queryBuilder(table) }) },
}));

const { default: ShiftRepository } = await import("./ShiftRepository");
const { default: LeaveRepository } = await import("./LeaveRepository");

describe("listMine filters on the signed-in user", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("ShiftRepository.listMine", async () => {
    const result = await ShiftRepository.listMine("user-1");
    expect(result.success).toBe(true);
    expect(calls).toEqual([{ table: "shift_assignments", filters: [["user_id", "user-1"]] }]);
  });

  it("LeaveRepository.listMine", async () => {
    const result = await LeaveRepository.listMine("user-1");
    expect(result.success).toBe(true);
    expect(calls).toEqual([{ table: "leave_requests", filters: [["user_id", "user-1"]] }]);
  });
});
