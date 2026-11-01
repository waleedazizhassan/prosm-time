// Fails when self-update code is in a Play web build. Run on a plain build:
// obfuscation hides strings from a text search.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PATTERN = /latest-version\.json|PROSM-Time\.apk|app-releases/;

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return name.endsWith(".js") ? [path] : [];
  });
}

const found = jsFiles(process.argv[2] ?? "dist").filter((file) => PATTERN.test(readFileSync(file, "utf8")));
if (found.length > 0) {
  console.error(`self-update code found in the Play bundle: ${found.join(", ")}`);
  process.exit(1);
}
