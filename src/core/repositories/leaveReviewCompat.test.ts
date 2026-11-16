// QA-002 (2026-11-16) - the leave decision sent p_expected_status (migration 20261115170000); a database without
// that migration answered PGRST202 "function not found" and no manager could decide a leave. The call is made again
// without the new field in that case; with the field known, it is sent once.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../database/DatabaseManager", () => ({ default: { getClient: () => ({ rpc }) } }));
const { default: LeaveRepository } = await import("./LeaveRepository");

describe("leave decision works with the database before and after 20261115170000", () => {
  beforeEach(() => rpc.mockReset());

  it("an older database: retried without p_expected_status, and the decision goes through", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    rpc.mockResolvedValueOnce({ data: { success: true }, error: null });
    const result = await LeaveRepository.review("11111111-1111-1111-1111-111111111111", "approved", "ok");
    expect(result.success).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_expected_status", "pending");
    expect(rpc.mock.calls[1][1]).not.toHaveProperty("p_expected_status");
  });

  it("an up-to-date database: one call, with what the screen saw", async () => {
    rpc.mockResolvedValueOnce({ data: { success: true }, error: null });
    await LeaveRepository.revokeApproved("11111111-1111-1111-1111-111111111111", "plans changed");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_expected_status", "approved");
  });

  it("a real refusal is not retried", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "THIS REQUEST WAS ALREADY DECIDED" } });
    const result = await LeaveRepository.review("11111111-1111-1111-1111-111111111111", "rejected");
    expect(result.success).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
