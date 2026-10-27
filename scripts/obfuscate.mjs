// PROSM Time - post-build code obfuscation.
//
// Runs after `vite build` on the emitted dist/ JavaScript. This is a
// pure output transform: no application source, UI or business logic is
// changed, only the readability of the shipped bundle.
//
// Settings are deliberately conservative. Options that are known to
// break real apps or to cost measurable runtime performance
// (controlFlowFlattening, deadCodeInjection, debugProtection with
// intervals, selfDefending on already-minified vendor chunks) are OFF.
//
// Skip locally with: PROSM_SKIP_OBFUSCATION=1 npm run build

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");

if (process.env.PROSM_SKIP_OBFUSCATION === "1") {
  console.log("[obfuscate] skipped (PROSM_SKIP_OBFUSCATION=1)");
  process.exit(0);
}

const OPTIONS = {
  compact: true,
  identifierNamesGenerator: "mangled-shuffled",
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.5,
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersType: "function",
  // v2.3.55: off - it tripled numeric code for little protection
  numbersToExpressions: false,
  transformObjectKeys: false, // would rename payload keys - never enable
  unicodeEscapeSequence: false,
  disableConsoleOutput: true,
  sourceMap: false,
  target: "browser",
};

async function* jsFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

let count = 0;
let before = 0;
let after = 0;

// v2.3.55 (owner 2026-10-27: "strong protection, but it must stay fast"):
// only the app's own code is protected - its rules, its server calls, its
// texts. The open-source libraries it ships (React, maps, PDF...) hide
// nothing, and obfuscating them made the bundle 2.7 times bigger and slower
// to open. A chunk is the app's own when it names PROSM Time's server calls.
const isAppCode = (code) => /prosm_time|prosm-time|PROSM Time/.test(code);
let skipped = 0;

for await (const file of jsFiles(distDir)) {
  const code = await readFile(file, "utf8");
  if (!isAppCode(code)) {
    skipped += 1;
    continue;
  }
  before += (await stat(file)).size;
  const result = JavaScriptObfuscator.obfuscate(code, OPTIONS).getObfuscatedCode();
  await writeFile(file, result, "utf8");
  after += Buffer.byteLength(result);
  count += 1;
}

console.log(
  `[obfuscate] ${count} app bundle(s) protected - ${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB; ${skipped} library bundle(s) left as built`,
);
