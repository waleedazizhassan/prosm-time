import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/supabaseClient", () => ({ getSupabaseClient: () => ({ rpc: vi.fn(async () => ({ data: null, error: null })) }) }));

import { registerStepUpConfirmer, stepUpCode, withStepUp } from "./stepUp";

afterEach(() => registerStepUpConfirmer(null));

describe("withStepUp (governance phase C)", () => {
  it("reads the server's two answers and nothing else", () => {
    expect(stepUpCode("STEP_UP_REQUIRED")).toBe("STEP_UP_REQUIRED");
    expect(stepUpCode("TRANSITION FAILED: MFA_REQUIRED")).toBe("MFA_REQUIRED");
    expect(stepUpCode("ONLY THE OWNER")).toBeNull();
    expect(stepUpCode(null)).toBeNull();
  });

  it("runs once when the server does not ask", async () => {
    const run = vi.fn(async () => ({ error: null }));
    await withStepUp("payroll.approve", run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("asks, then runs once more when the person confirms", async () => {
    const run = vi.fn().mockResolvedValueOnce({ error: "STEP_UP_REQUIRED" }).mockResolvedValueOnce({ error: null });
    const confirm = vi.fn(async () => true);
    registerStepUpConfirmer(confirm);
    expect((await withStepUp("payroll.approve", run)).error).toBeNull();
    expect(confirm).toHaveBeenCalledWith("STEP_UP_REQUIRED");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps the refusal when the person cancels", async () => {
    const run = vi.fn(async () => ({ error: "MFA_REQUIRED" }));
    registerStepUpConfirmer(async () => false);
    expect((await withStepUp("apikey.create", run)).error).toBe("MFA_REQUIRED");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
