// Plan stage 4.4: fails when interface code holds fixed text instead of a
// translation key. Comments, tests and the legal texts are left out.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP = /.test.|privacyPolicyV2|legalContent|/locales/|i18n/languages.ts|modules/legal/LegalPage.tsx/;
const ARABIC_WORD = /[؀-ۿ]{2,}/;
const JSX_ENGLISH = />\s*[A-Z][a-z]+( [a-z]+)+\s*</;

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !SKIP.test(path.replace(/\/g, "/")) ? [path] : [];
  });
}

const found = [];
for (const file of files("src")) {
  readFileSync(file, "utf8").split("\n").forEach((line, index) => {
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "").replace(/\/\/ .*$/, "");
    if (ARABIC_WORD.test(code) || (file.endsWith(".tsx") && JSX_ENGLISH.test(code))) found.push(`${file}:${index + 1}: ${code.trim().slice(0, 90)}`);
  });
}
if (found.length > 0) {
  console.error(`Fixed text in the interface:\n${found.join("\n")}`);
  process.exit(1);
}
console.log("no fixed text in the interface");
