import { describe, expect, it } from "vitest";

import { extractMapLink, isShortMapLink, parseMapLink } from "./mapLink";

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

  it("finds the link inside what the phone's Share gives (owner 2026-11-13)", () => {
    expect(parseMapLink("Amon Factory\nhttps://maps.app.goo.gl/AbCd123")).toBe("short");
    expect(extractMapLink("مصنع آمون https://maps.app.goo.gl/AbCd123?g_st=aw")).toBe("https://maps.app.goo.gl/AbCd123?g_st=aw");
    expect(parseMapLink("See https://www.google.com/maps/place/Amon/@30.0444,31.2357,17z/data=!3d30.0450!4d31.2360 here")).toEqual({ latitude: 30.045, longitude: 31.236 });
    expect(parseMapLink("https://maps.google.com/?q=30.0444,31.2357")).toEqual({ latitude: 30.0444, longitude: 31.2357 });
  });
});
