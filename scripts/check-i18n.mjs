// Audit 2026-10-12, item 5.2 - fails when the code uses a translation key
// that a language file does not have (the E2E test saw "ACTIONS.LABEL" as
// a column header). Checks every literal t("ns:key") in src/, and t("key")
// where the file's own useTranslation("ns") gives the namespace, against
// all five languages. Keys built at run time (template strings) are not
// checked. Usage: node scripts/check-i18n.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const localesDir = join(root, "src", "i18n", "locales");
const languages = readdirSync(localesDir).filter((name) => statSync(join(localesDir, name)).isDirectory());

const locales = {};
for (const language of languages) {
  locales[language] = {};
  for (const file of readdirSync(join(localesDir, language)).filter((name) => name.endsWith(".json"))) {
    locales[language][file.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(localesDir, language, file), "utf8"));
  }
}

function has(language, namespace, key) {
  const lookup = (path) => {
    let node = locales[language][namespace];
    for (const part of path.split(".")) {
      if (node === undefined || node === null || typeof node !== "object") return undefined;
      node = node[part];
    }
    return node;
  };
  // i18next plurals: key_one / key_other stand for key.
  return [key, `${key}_one`, `${key}_other`].some((candidate) => lookup(candidate) !== undefined);
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "i18n" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const problems = [];
let checked = 0;
for (const file of sourceFiles(join(root, "src"))) {
  const source = readFileSync(file, "utf8");
  // const { t } = useTranslation("ns") / useTranslation(["ns", ...]) - the namespace of a bare t("key").
  const bindings = [...source.matchAll(/const\s*\{\s*([^}]*)\}\s*=\s*useTranslation\(\s*\[?\s*"([^"]+)"/g)];
  const plainT = bindings.filter((match) => /(^|,)\s*t\s*(,|$)/.test(match[1]));
  const defaultNamespace = plainT.length === 1 ? plainT[0][2] : null;

  for (const match of source.matchAll(/\bt\(\s*"([^"$`{}]+)"/g)) {
    const raw = match[1];
    let namespace;
    let key;
    if (raw.includes(":")) [namespace, key] = raw.split(":", 2);
    else if (defaultNamespace) [namespace, key] = [defaultNamespace, raw];
    else continue;
    if (!(namespace in locales.en)) continue;
    checked += 1;
    const line = source.slice(0, match.index).split("\n").length;
    for (const language of languages) {
      if (!has(language, namespace, key)) problems.push(`${relative(root, file)}:${line}  ${namespace}:${key}  missing in ${language}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} missing translation(s).`);
  process.exit(1);
}
console.log(`i18n check: ${checked} keys, all present in ${languages.join(", ")}.`);
