#!/usr/bin/env node
// PROSM Time - one source of truth for the version number.
//
// package.json's "version" is the ONLY place a release number is authored.
// This script propagates it to the places that cannot import it (Android's
// build.gradle), so a release can never ship with two different versions.
// Run: node scripts/sync-version.mjs [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`[version] package.json version "${version}" is not a plain x.y.z release version`);
  process.exit(1);
}

// A monotonic Android versionCode derived from the same version string.
const [major, minor, patch] = version.split(".").map(Number);
const versionCode = major * 10000 + minor * 100 + patch;

const gradlePath = path.join(root, "android", "app", "build.gradle");
const gradle = readFileSync(gradlePath, "utf8");
const updated = gradle
  .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  .replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);

if (checkOnly) {
  if (updated !== gradle) {
    console.error(`[version] android/app/build.gradle is out of sync with package.json (${version}).`);
    console.error("[version] run: node scripts/sync-version.mjs");
    process.exit(1);
  }
  console.log(`[version] all version references agree on ${version} (versionCode ${versionCode})`);
  process.exit(0);
}

if (updated !== gradle) writeFileSync(gradlePath, updated);
console.log(`[version] synced ${version} (Android versionCode ${versionCode})`);
