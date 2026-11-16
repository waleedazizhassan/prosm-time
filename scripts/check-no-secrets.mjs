// Governance phase A (owner 2026-11-15, report section 9, DEC-14): the web build and the APK's web assets must
// never carry a server secret. Fails the release if the built folder contains a Supabase secret key, a
// service_role JWT, or a service-account private key. Usage: node scripts/check-no-secrets.mjs <folder>...
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const PATTERNS = [
  { name: "Supabase secret key (sb_secret_)", re: /sb_secret_[A-Za-z0-9_-]{10,}/ },
  // a JWT whose payload says "role":"service_role" - base64 of `"role":"service_role"` at the three alignments
  { name: "service_role JWT", re: /InJvbGUiOiJzZXJ2aWNlX3JvbGUi|cm9sZSI6InNlcnZpY2Vfcm9sZS|icm9sZSI6InNlcnZpY2Vfcm9sZS/ },
  { name: "service_role key variable", re: /SUPABASE_SERVICE_ROLE_KEY/ },
  { name: "private key", re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
];
const TEXT = new Set([".js", ".mjs", ".css", ".html", ".json", ".map", ".txt", ".webmanifest", ".xml"]);

const folders = process.argv.slice(2);
if (folders.length === 0) {
  console.error("usage: node scripts/check-no-secrets.mjs <folder>...");
  process.exit(2);
}

const findings = [];
const walk = (path) => {
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (TEXT.has(extname(name).toLowerCase())) {
      const text = readFileSync(full, "utf8");
      for (const { name: kind, re } of PATTERNS) if (re.test(text)) findings.push(`${full}: ${kind}`);
    }
  }
};
for (const folder of folders) walk(folder);

if (findings.length > 0) {
  console.error("Server secrets found in the build - the release is stopped:\n" + findings.join("\n"));
  process.exit(1);
}
console.log(`No server secrets in ${folders.join(", ")}.`);
