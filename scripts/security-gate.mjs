#!/usr/bin/env node
// PROSM Time - the CI security gate (Finalization & Release Pipeline phase,
// user-directed).
//
// The pipeline itself is part of the security boundary: this script re-proves
// on EVERY build that the protections already in the product are still there.
// Any failure stops the release. It is deliberately blunt - it fails loudly
// rather than assuming an omission was intentional.
//
// Run after `npm run build` so it can inspect dist/ as well:
//   node scripts/security-gate.mjs

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const checks = [];

function check(name, ok, detail = "") {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
}

function read(relative) {
  const file = path.join(root, relative);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. No server secret may ever reach a client artifact.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  [/SUPABASE_SERVICE_ROLE_KEY/, "service role key reference"],
  [/service_role/, "service_role literal"],
  [/sb_secret_[A-Za-z0-9_-]{10,}/, "secret API key"],
  [/PROSM_MANAGEMENT_API_KEY/, "management API key reference"],
  [/PROSM_PROTECTION_SIGNING_KEY/, "protection signing key reference"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
];

const clientFiles = [
  ...walk(path.join(root, "src")),
  ...walk(path.join(root, "dist")),
  ...walk(path.join(root, "electron")),
].filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs|json|html|css)$/.test(file));

const leaks = [];
for (const file of clientFiles) {
  const content = readFileSync(file, "utf8");
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(content)) leaks.push(`${path.relative(root, file)} (${label})`);
  }
}
check("no server secrets in client artifacts", leaks.length === 0, leaks.slice(0, 5).join(", "));

// ---------------------------------------------------------------------------
// 2. Client build hardening must stay enabled.
// ---------------------------------------------------------------------------
const vite = read("vite.config.ts");
check("web build ships no source maps", /sourcemap:\s*false/.test(vite));
check("web build is minified with terser", /minify:\s*"terser"/.test(vite));
check("web build drops console/debugger", /drop_console:\s*true/.test(vite) && /drop_debugger:\s*true/.test(vite));

const sourceMaps = walk(path.join(root, "dist")).filter((file) => file.endsWith(".map"));
check("no .map files in dist", sourceMaps.length === 0, sourceMaps.slice(0, 3).join(", "));

const pkg = JSON.parse(read("package.json") || "{}");
check("release build runs the obfuscation step", String(pkg.scripts?.build ?? "").includes("scripts/obfuscate.mjs"));
check("desktop build packs into an asar archive", pkg.build?.asar === true);

// ---------------------------------------------------------------------------
// 3. Android and desktop hardening must stay enabled.
// ---------------------------------------------------------------------------
const gradle = read("android/app/build.gradle");
check("android release runs R8", /minifyEnabled\s+true/.test(gradle));
check("android release shrinks resources", /shrinkResources\s+true/.test(gradle));
check("android release is not debuggable", /debuggable\s+false/.test(gradle));

const manifest = read("android/app/src/main/AndroidManifest.xml");
check("android forbids cleartext traffic", /usesCleartextTraffic="false"/.test(manifest));
check("android disables backup extraction", /allowBackup="false"/.test(manifest));

const electron = read("electron/main.js");
check("desktop disables devtools in packaged builds", /devTools:\s*ALLOW_DEVTOOLS/.test(electron));
check("desktop blocks off-origin navigation", /will-navigate/.test(electron));

// ---------------------------------------------------------------------------
// 4. Server-side enforcement must still be wired.
// ---------------------------------------------------------------------------
const gate = read("supabase/functions/_shared/licenseGate.ts");
check("license gate calls the server-side RPC", gate.includes("enforce_prosm_time_license_gate"));
check("license gate fails closed when unavailable", /fatal:\s*errorResponse/.test(gate) && !/allowed:\s*true,\s*\n\s*state:\s*"GATE_UNAVAILABLE"/.test(gate));

const PROTECTED = [
  "clock-in", "clock-out", "admin-clock-in", "admin-clock-out",
  "submit-timesheet", "approve-timesheet", "invite-user",
  "export-employee-data", "set-kiosk-pin",
];
const ungated = PROTECTED.filter((fn) => !read(`supabase/functions/${fn}/index.ts`).includes("enforceLicenseGate("));
check("every protected operation passes the license gate", ungated.length === 0, ungated.join(", "));

// ---------------------------------------------------------------------------
// 5. Database security must stay in place.
// ---------------------------------------------------------------------------
const migrationsDir = path.join(root, "supabase", "migrations");
const migrations = walk(migrationsDir).filter((file) => file.endsWith(".sql"));
check("migrations are present", migrations.length > 0);

const definerWithoutSearchPath = [];
for (const file of migrations) {
  const sql = readFileSync(file, "utf8");
  const blocks = sql.split(/create\s+or\s+replace\s+function|create\s+function/i).slice(1);
  for (const block of blocks) {
    const head = block.slice(0, block.search(/\$\$|\bas\s+\$/i) + 1 || 2000);
    if (/security\s+definer/i.test(head) && !/set\s+search_path/i.test(head)) {
      definerWithoutSearchPath.push(path.basename(file));
      break;
    }
  }
}
check("every SECURITY DEFINER function pins search_path", definerWithoutSearchPath.length === 0, [...new Set(definerWithoutSearchPath)].join(", "));

const licenseMigration = migrations.find((file) => file.includes("installation_identity_and_license_enforcement"));
const licenseSql = licenseMigration ? readFileSync(licenseMigration, "utf8") : "";
check("installation identity migration is present", Boolean(licenseMigration));
check("installation tables enable row level security", /enable\s+row\s+level\s+security/i.test(licenseSql));
check("installation secrets are stored hashed, never raw", /secret_hash/i.test(licenseSql));
check("grace period is computed from the server clock", /now\(\)/i.test(licenseSql));

check("security SQL regression suite is present", existsSync(path.join(root, "supabase/tests/security/license_enforcement.test.sql")));
check("password reset hardening is present", migrations.some((file) => file.includes("security_hardening_password_reset")));

// ---------------------------------------------------------------------------
// 6. Version consistency.
// ---------------------------------------------------------------------------
check("android versionName matches package.json", gradle.includes(`versionName "${pkg.version}"`), `expected ${pkg.version}`);

// ---------------------------------------------------------------------------
for (const { name, ok } of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
console.log(`\n${checks.length - failures.length}/${checks.length} security checks passed`);

if (failures.length > 0) {
  console.error("\nSECURITY GATE FAILED - release stopped:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("SECURITY GATE PASSED");
