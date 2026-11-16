// QA 2026-11-16 - the dashboard sent the same heavy request up to four times at once and every copy hit the
// database's statement timeout ("canceling statement due to statement timeout", 57014). Identical requests in
// flight share one answer; a later request (after the first finished) goes to the server again.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../database/DatabaseManager", () => ({ default: { getClient: () => ({ rpc }) } }));

const { default: DashboardRepository } = await import("./DashboardRepository");
const { default: AttendanceControlRepository } = await import("./AttendanceControlRepository");

describe("identical requests in flight are sent once", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ data: { kpi: {} }, error: null }), 20)));
  });

  it("the dashboard: four identical loads at once -> one call; another period -> its own call", async () => {
    const same = () => DashboardRepository.load("2026-11-15", "2026-11-21", "org", null);
    const results = await Promise.all([same(), same(), same(), same(), DashboardRepository.load("2026-11-01", "2026-11-30", "org", null)]);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(results.every((r) => r.success)).toBe(true);
    await same();
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("the permission queue: two cards asking at once -> one call", async () => {
    rpc.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ data: { requests: [], overtime: [] }, error: null }), 20)));
    await Promise.all([AttendanceControlRepository.queue(), AttendanceControlRepository.queue()]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
