import { describe, expect, it } from "vitest";

import { isShortMapLink, parseMapLink } from "./mapLink";

describe("parseMapLink (owner 2026-11-12: a pasted map link becomes the site)", () => {
  it("reads the place from a full Google Maps link", () => {
    expect(parseMapLink("https://www.google.com/maps/place/Akhbar/@29.9405,30.8901,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d29.940585!4d30.890106")).toEqual({ latitude: 29.940585, longitude: 30.890106 });
    expect(parseMapLink("https://www.google.com/maps/@29.9405,30.8901,17z")).toEqual({ latitude: 29.9405, longitude: 30.8901 });
    expect(parseMapLink("https://maps.google.com/?q=29.940585,30.890106")).toEqual({ latitude: 29.940585, longitude: 30.890106 });
    expect(parseMapLink("https://www.google.com/maps/search/?api=1&query=29.94%2C30.89")).toEqual({ latitude: 29.94, longitude: 30.89 });
  });

  it("reads plain coordinates, Arabic digits and comma included", () => {
    expect(parseMapLink("29.940585, 30.890106")).toEqual({ latitude: 29.940585, longitude: 30.890106 });
    expect(parseMapLink("٢٩٫٩٤٠٥٨٥، ٣٠٫٨٩٠١٠٦")).toEqual({ latitude: 29.940585, longitude: 30.890106 });
    expect(parseMapLink("geo:29.94,30.89")).toEqual({ latitude: 29.94, longitude: 30.89 });
  });

  it("knows a short shared link must be opened first, and refuses nonsense", () => {
    expect(parseMapLink("https://maps.app.goo.gl/AbCd123")).toBe("short");
    expect(isShortMapLink("maps.app.goo.gl/AbCd123")).toBe(true);
    expect(parseMapLink("hello")).toBeNull();
    expect(parseMapLink("95, 30")).toBeNull();
  });
});
