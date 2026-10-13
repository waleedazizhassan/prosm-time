// Audit 1.4 - a live attendance action must not send the phone's clock as
// its time; only the offline queue marks a send as an offline replay.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invocations: Array<{ name: string; body: Record<string, unknown> }> = [];

vi.mock("../database/DatabaseManager", () => ({
  default: {
    getClient: () => ({
      functions: {
        invoke: (name: string, { body }: { body: Record<string, unknown> }) => {
          invocations.push({ name, body });
          return Promise.resolve({ data: { success: true, data: { sessionId: "s1", eventId: "e1", breakId: "b1", maxDurationExceeded: false, siteChangeId: "c1" } }, error: null });
        },
      },
    }),
  },
}));

const { default: AttendanceRepository } = await import("./AttendanceRepository");

describe("attendance time source", () => {
  beforeEach(() => {
    invocations.length = 0;
  });

  it("sends live actions without a device time and without the offline flag", async () => {
    await AttendanceRepository.clockIn({ siteId: "site-1" });
    await AttendanceRepository.clockOut({});
    await AttendanceRepository.startBreak("s1");
    await AttendanceRepository.endBreak("b1");
    await AttendanceRepository.changeSite(null, "site-2", 30, 31, 8);

    expect(invocations.map((call) => call.name)).toEqual(["clock-in", "clock-out", "start-break", "end-break", "change-site"]);
    for (const call of invocations) {
      expect(call.body.clientReportedAt).toBeNull();
      expect(call.body.offlineReplay).toBe(false);
    }
  });

  it("sends the device's fake-location flag with clock in and out (audit 2.4)", async () => {
    await AttendanceRepository.clockIn({ siteId: "site-1", isMockLocation: true });
    await AttendanceRepository.clockOut({ isMockLocation: false });
    await AttendanceRepository.clockIn({ siteId: "site-1" });
    expect(invocations.map((call) => call.body.isMockLocation)).toEqual([true, false, null]);
  });

  it("marks an offline-queue send as a replay with the time it happened", async () => {
    const options = { idempotencyKey: "q1", clientReportedAt: "2026-10-13T06:00:00.000Z", offlineReplay: true };
    await AttendanceRepository.clockIn({ siteId: "site-1", ...options });
    await AttendanceRepository.startBreak("s1", options);

    for (const call of invocations) {
      expect(call.body).toMatchObject({ idempotencyKey: "q1", clientReportedAt: "2026-10-13T06:00:00.000Z", offlineReplay: true });
    }
  });
});
