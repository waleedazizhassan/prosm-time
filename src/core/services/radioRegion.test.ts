// Owner 2026-10-27: the radio's default stations follow where the app is used.
import { describe, expect, it } from "vitest";

import { radioCountry, radioNeighbour } from "./radioRegion";

describe("radioCountry", () => {
  it("reads the country from the time zone", () => {
    expect(radioCountry("Africa/Cairo", [])).toBe("EG");
    expect(radioCountry("America/New_York", [])).toBe("US");
    expect(radioCountry("Europe/Berlin", [])).toBe("DE");
  });

  it("falls back to the language's region, then to none", () => {
    expect(radioCountry("Asia/Unknown", ["ar-EG"])).toBe("EG");
    expect(radioCountry("Asia/Unknown", ["ar"])).toBeNull();
  });

  it("names a neighbour for a second choice", () => {
    expect(radioNeighbour("EG")).toBe("SA");
    expect(radioNeighbour(null)).toBeNull();
  });
});
