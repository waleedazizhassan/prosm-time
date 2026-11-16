// QA-003 (2026-11-16) - /payroll checked payroll.access, its sub-pages (cycles, profiles, settings, tax, requests)
// and /workers/pay checked only the plan: a manager typing the address got the page with a "no payroll permission"
// error. Every payroll and external-pay route sits behind an AccessRoute (the server still refuses the data).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "AppRoutes.tsx"), "utf8");
const routes = [...source.matchAll(/<Route path="(\/(?:payroll|workers\/pay)[^"]*)" element=\{(.*?)\} \/>/g)].map((m) => ({ path: m[1], element: m[2] }));

describe("payroll and external-pay pages need their permission, not only the plan", () => {
  it("finds the routes", () => {
    expect(routes.map((r) => r.path)).toEqual(expect.arrayContaining(["/payroll", "/payroll/profiles", "/payroll/settings", "/payroll/tax", "/payroll/requests", "/payroll/cycles/:cycleId", "/workers/pay", "/workers/pay/:runId"]));
  });
  it.each(routes.map((r) => [r.path, r.element]))("%s is behind an AccessRoute", (_path, element) => {
    expect(element).toMatch(/^<AccessRoute anyOf=\{\[/);
  });
  it("the external-pay pages ask for what the server asks (view_pay or manage_policy), not just seeing workers", () => {
    for (const r of routes.filter((x) => x.path.startsWith("/workers/pay"))) {
      expect(r.element).toContain('anyOf={["external_labor.view_pay", "external_labor.manage_policy"]}');
    }
  });
});
