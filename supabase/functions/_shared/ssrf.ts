// Outbound safety for webhooks (spec 19.x / 17.x: SSRF and DNS rebinding). A webhook may only reach
// a public address over HTTPS on port 443: no private, loopback, link-local, carrier-grade NAT,
// multicast, documentation or reserved ranges, no metadata endpoints, no internal host names.
// The host name is resolved right before each delivery and every answer must be public; redirects
// are never followed. Residual risk (documented): an answer could change between this check and the
// connection; the window is milliseconds and the delivery carries no secret beyond its signature.

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

export function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((ipv4ToInt(base)! & mask) >>> 0);
  });
}

export function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::" || lower === "::1") return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const first = parseInt(lower.split(":")[0] || "0", 16);
  if (Number.isNaN(first)) return true;
  return (first & 0xfe00) === 0xfc00 // unique local fc00::/7
    || (first & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (first & 0xff00) === 0xff00 // multicast
    || lower.startsWith("2001:db8") // documentation
    || lower.startsWith("64:ff9b"); // NAT64 (could reach private IPv4)
}

export function isBlockedIp(ip: string): boolean {
  return ip.includes(":") ? isBlockedIpv6(ip) : isBlockedIpv4(ip);
}

const INTERNAL_HOST = /(^localhost$)|(\.localhost$)|(\.local$)|(\.internal$)|(\.intranet$)|(\.lan$)|(\.home$)|(\.corp$)|(^metadata\.google\.internal$)/i;

/** The static part: scheme, port, host shape. Returns a reason, or null when the address may be used. */
export function urlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid_url";
  }
  if (url.protocol !== "https:") return "https_only";
  if (url.port && url.port !== "443") return "port_443_only";
  if (url.username || url.password) return "no_credentials_in_url";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (INTERNAL_HOST.test(host) || !host.includes(".") && !host.includes(":")) return "internal_host";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return isBlockedIp(host) ? "private_address" : null;
  return null;
}

/** The full check right before a delivery: the static rules, then every DNS answer must be public. */
export async function checkWebhookUrl(raw: string, resolve: (host: string, type: "A" | "AAAA") => Promise<string[]>): Promise<string | null> {
  const problem = urlProblem(raw);
  if (problem) return problem;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return null;
  const answers = [
    ...(await resolve(host, "A").catch(() => [] as string[])),
    ...(await resolve(host, "AAAA").catch(() => [] as string[])),
  ];
  if (answers.length === 0) return "does_not_resolve";
  return answers.some(isBlockedIp) ? "private_address" : null;
}
