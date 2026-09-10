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
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.7,
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: "function",
  numbersToExpressions: true,
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

for await (const file of jsFiles(distDir)) {
  const code = await readFile(file, "utf8");
  before += (await stat(file)).size;
  const result = JavaScriptObfuscator.obfuscate(code, OPTIONS).getObfuscatedCode();
  await writeFile(file, result, "utf8");
  after += Buffer.byteLength(result);
  count += 1;
}

console.log(
  `[obfuscate] ${count} bundle(s) protected - ${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB`,
);
