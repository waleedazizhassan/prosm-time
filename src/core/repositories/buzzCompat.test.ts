// QA-015 (2026-11-16) - the eight newer Buzz reasons (migration 20261116100000) were refused by a database without
// that migration ("INVALID BUZZ REASON"): the button failed. The buzz now still goes out as "check the app" with the
// reason in words; with the newer database it is sent once, as chosen; an original reason is never re-sent.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../database/DatabaseManager", () => ({ default: { getClient: () => ({ rpc }) } }));
const { default: NotificationRepository } = await import("./NotificationRepository");

describe("Buzz works with the database before and after 20261116100000", () => {
  beforeEach(() => rpc.mockReset());

  it("an older database: a newer reason goes out as 'attention' carrying its words", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "INVALID BUZZ REASON" } });
    rpc.mockResolvedValueOnce({ data: { success: true }, error: null });
    const result = await NotificationRepository.sendBuzz("u1", "go_home_early", null, "You can go home early today.");
    expect(result.success).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).toEqual({ p_user_id: "u1", p_reason: "attention", p_message: "You can go home early today." });
  });

  it("the sender's own short message wins over the reason's words", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "INVALID BUZZ REASON" } });
    rpc.mockResolvedValueOnce({ data: { success: true }, error: null });
    await NotificationRepository.sendBuzz("u1", "tomorrow_off", "Enjoy", "You are off tomorrow.");
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_reason: "attention", p_message: "Enjoy" });
  });

  it("a newer database: one call, as chosen; an original reason refused is not re-sent", async () => {
    rpc.mockResolvedValueOnce({ data: { success: true }, error: null });
    await NotificationRepository.sendBuzz("u1", "well_done", null, "Well done");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_reason: "well_done" });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "INVALID BUZZ REASON" } });
    const result = await NotificationRepository.sendBuzz("u1", "clock_in", null, "Clock in");
    expect(result.success).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
