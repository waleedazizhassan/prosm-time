#!/usr/bin/env node
// PROSM Time - publishes the release manifest the clients poll for update
// awareness (Finalization & Release Pipeline phase, user-directed).
//
// The manifest is DATA ONLY: a version number, notes and official download
// pages. It carries no commands and no code, so it can never act as a
// remote-control or kill channel. Written into dist/ so it is deployed with
// the web build.
//
// Env:
//   PROSM_RELEASE_NOTES      short human summary (optional)
//   PROSM_RELEASE_SECURITY   "true" to mark a security-critical release
//   PROSM_ANDROID_URL        official APK download page (https)
//   PROSM_WINDOWS_URL        official installer download page (https)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const https = (value) => (typeof value === "string" && value.startsWith("https://") ? value : undefined);

const manifest = {
  version,
  releasedAt: new Date().toISOString(),
  notes: process.env.PROSM_RELEASE_NOTES || null,
  security: process.env.PROSM_RELEASE_SECURITY === "true",
  downloads: {
    android: https(process.env.PROSM_ANDROID_URL),
    windows: https(process.env.PROSM_WINDOWS_URL),
  },
};

const outDir = path.join(root, "dist");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[release] manifest written for v${version}`);
