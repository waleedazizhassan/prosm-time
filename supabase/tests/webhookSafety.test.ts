// 2026-11-09 webhooks outbound safety (supabase/functions/_shared/ssrf.ts): only public HTTPS on
// port 443; private, loopback, link-local, CGNAT, metadata and internal names refused - also when
// a public-looking name resolves to a private address (DNS rebinding at check time).
import { describe, expect, it } from "vitest";

import { checkWebhookUrl, isBlockedIp, urlProblem } from "../functions/_shared/ssrf";

describe("webhook addresses", () => {
  it("refuse private, loopback, link-local, CGNAT, multicast and documentation ranges", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.5", "192.168.1.10", "100.64.1.1", "0.0.0.0", "224.0.0.1", "198.51.100.7",
      "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "41.33.10.5", "2a00:1450:4001:80b::200e"]) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it("allow only https on 443, no credentials, no internal names", () => {
    expect(urlProblem("https://erp.example.com/hooks")).toBeNull();
    expect(urlProblem("http://erp.example.com/hooks")).toBe("https_only");
    expect(urlProblem("https://erp.example.com:8443/hooks")).toBe("port_443_only");
    expect(urlProblem("https://user:pw@erp.example.com/")).toBe("no_credentials_in_url");
    expect(urlProblem("https://localhost/x")).toBe("internal_host");
    expect(urlProblem("https://metadata.google.internal/")).toBe("internal_host");
    expect(urlProblem("https://printer/x")).toBe("internal_host");
    expect(urlProblem("https://10.0.0.5/x")).toBe("private_address");
    expect(urlProblem("https://[::1]/x")).toBe("private_address");
  });

  it("check every DNS answer right before delivery", async () => {
    const dns = (answers: Record<string, string[]>) => async (host: string, type: "A" | "AAAA") => answers[`${host}/${type}`] ?? [];
    expect(await checkWebhookUrl("https://erp.example.com/h", dns({ "erp.example.com/A": ["93.184.216.34"] }))).toBeNull();
    expect(await checkWebhookUrl("https://rebind.example.com/h", dns({ "rebind.example.com/A": ["93.184.216.34", "127.0.0.1"] }))).toBe("private_address");
    expect(await checkWebhookUrl("https://v6.example.com/h", dns({ "v6.example.com/AAAA": ["fd12::1"] }))).toBe("private_address");
    expect(await checkWebhookUrl("https://nothing.example.com/h", dns({}))).toBe("does_not_resolve");
  });
});
