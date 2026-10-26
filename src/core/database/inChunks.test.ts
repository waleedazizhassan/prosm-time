// v2.3.50: long id lists are sent in batches (a month of attendance made the
// request address too long for the server gateway).
import { describe, expect, it } from "vitest";

import { selectInChunks } from "./inChunks";

describe("selectInChunks", () => {
  it("asks in batches and returns every row, in order", async () => {
    const ids = Array.from({ length: 123 }, (_, i) => `id${i}`);
    const batches: number[] = [];
    const result = await selectInChunks(ids, async (chunk) => {
      batches.push(chunk.length);
      return { data: chunk.map((id) => ({ id })), error: null };
    });
    expect(batches).toEqual([50, 50, 23]);
    expect(result.data.map((row) => row.id)).toEqual(ids);
    expect(result.error).toBeNull();
  });

  it("stops at the first failed batch and reports its error", async () => {
    let calls = 0;
    const result = await selectInChunks(["a", "b", "c"], async () => {
      calls += 1;
      return calls === 2 ? { data: null, error: { message: "boom" } } : { data: [{ ok: true }], error: null };
    }, 1);
    expect(result.error?.message).toBe("boom");
    expect(calls).toBe(2);
  });

  it("asks nothing for no ids", async () => {
    let calls = 0;
    const result = await selectInChunks([], async () => {
      calls += 1;
      return { data: [], error: null };
    });
    expect(calls).toBe(0);
    expect(result.data).toEqual([]);
  });
});
