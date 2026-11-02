// v2.3.43 step 13 (item 15): which site the employee is in, or the nearest one.
import { describe, expect, it } from "vitest";

import { nearestSite, orderSitesByDistance } from "./siteProximity";

const plant = { id: "plant", latitude: 30.0212, longitude: 31.7581, allowedRadiusMeters: 150, gpsAccuracyToleranceMeters: 50 };
const tower = { id: "tower", latitude: 30.0444, longitude: 31.2357, allowedRadiusMeters: 100, gpsAccuracyToleranceMeters: 50 };

describe("nearestSite", () => {
  it("picks the site the person is inside", () => {
    const result = nearestSite([tower, plant], 30.0213, 31.7582, 10);
    expect(result).toMatchObject({ siteId: "plant", inside: true, outsideByMeters: 0 });
  });

  it("outside every site: the nearest, with how far outside its area", () => {
    const result = nearestSite([tower, plant], 30.0262, 31.7581, 10); // ~556 m north of the plant
    expect(result?.siteId).toBe("plant");
    expect(result?.inside).toBe(false);
    expect(result?.outsideByMeters).toBeGreaterThan(380);
    expect(result?.outsideByMeters).toBeLessThan(410);
  });

  it("a poor reading gets the site's GPS tolerance at most", () => {
    const result = nearestSite([plant], 30.0228, 31.7581, 500); // ~178 m away, ±500 m reading
    expect(result?.inside).toBe(true);
    const far = nearestSite([plant], 30.0262, 31.7581, 500);
    expect(far?.inside).toBe(false);
  });

  it("no sites with an area: nothing", () => {
    expect(nearestSite([], 30, 31, 5)).toBeNull();
  });
});

describe("orderSitesByDistance", () => {
  const nowhere = { id: "nowhere", latitude: null, longitude: null, allowedRadiusMeters: 0 };

  it("puts the site the person stands in first, marks it, then the nearest", () => {
    const far = { ...tower, id: "far", latitude: 31.2, longitude: 29.9 };
    const result = orderSitesByDistance([nowhere, far, tower, plant], { latitude: 30.0213, longitude: 31.7582, accuracyMeters: 10 });
    expect(result.map((entry) => entry.site.id)).toEqual(["plant", "tower", "far", "nowhere"]);
    expect(result.map((entry) => entry.inside)).toEqual([true, false, false, false]);
  });

  it("without a reading keeps the order", () => {
    expect(orderSitesByDistance([tower, plant], null).map((entry) => entry.site.id)).toEqual(["tower", "plant"]);
  });
});
