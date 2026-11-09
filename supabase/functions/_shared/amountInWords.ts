// An amount written in words for payslips and pay statements (owner 2026-11-09, the reference
// payslip: "فقط ثلاثة آلاف وثمانية وسبعون جنيهًا وستون قرشًا لا غير"). Arabic follows the
// counted-noun rules (1, 2, 3-10, 11-99, hundreds); other languages use English words.
// The same file is copied to supabase/functions/_shared/amountInWords.ts for the server PDF -
// a unit test keeps the two identical. No imports, so it runs in the browser and in Deno.

interface Noun {
  /** singular, dual, plural (3-10), accusative singular (11-99) */
  forms: [string, string, string, string];
  feminine?: boolean;
}

interface Currency {
  ar: { major: Noun; minor: Noun | null };
  en: { major: [string, string]; minor: [string, string] | null };
  minorUnits: number;
}

const CURRENCIES: Record<string, Currency> = {
  EGP: { ar: { major: { forms: ["جنيه", "جنيهان", "جنيهات", "جنيهًا"] }, minor: { forms: ["قرش", "قرشان", "قروش", "قرشًا"] } }, en: { major: ["Egyptian pound", "Egyptian pounds"], minor: ["piastre", "piastres"] }, minorUnits: 100 },
  SAR: { ar: { major: { forms: ["ريال", "ريالان", "ريالات", "ريالًا"] }, minor: { forms: ["هللة", "هللتان", "هللات", "هللة"], feminine: true } }, en: { major: ["Saudi riyal", "Saudi riyals"], minor: ["halala", "halalas"] }, minorUnits: 100 },
  AED: { ar: { major: { forms: ["درهم", "درهمان", "دراهم", "درهمًا"] }, minor: { forms: ["فلس", "فلسان", "فلوس", "فلسًا"] } }, en: { major: ["UAE dirham", "UAE dirhams"], minor: ["fils", "fils"] }, minorUnits: 100 },
  QAR: { ar: { major: { forms: ["ريال", "ريالان", "ريالات", "ريالًا"] }, minor: { forms: ["درهم", "درهمان", "دراهم", "درهمًا"] } }, en: { major: ["Qatari riyal", "Qatari riyals"], minor: ["dirham", "dirhams"] }, minorUnits: 100 },
  KWD: { ar: { major: { forms: ["دينار", "ديناران", "دنانير", "دينارًا"] }, minor: { forms: ["فلس", "فلسان", "فلوس", "فلسًا"] } }, en: { major: ["Kuwaiti dinar", "Kuwaiti dinars"], minor: ["fils", "fils"] }, minorUnits: 1000 },
  JOD: { ar: { major: { forms: ["دينار", "ديناران", "دنانير", "دينارًا"] }, minor: { forms: ["فلس", "فلسان", "فلوس", "فلسًا"] } }, en: { major: ["Jordanian dinar", "Jordanian dinars"], minor: ["fils", "fils"] }, minorUnits: 1000 },
  USD: { ar: { major: { forms: ["دولار", "دولاران", "دولارات", "دولارًا"] }, minor: { forms: ["سنت", "سنتان", "سنتات", "سنتًا"] } }, en: { major: ["US dollar", "US dollars"], minor: ["cent", "cents"] }, minorUnits: 100 },
  EUR: { ar: { major: { forms: ["يورو", "يورو", "يورو", "يورو"] }, minor: { forms: ["سنت", "سنتان", "سنتات", "سنتًا"] } }, en: { major: ["euro", "euros"], minor: ["cent", "cents"] }, minorUnits: 100 },
};

// --- Arabic -------------------------------------------------------------------------------------
const AR_ONES_M = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"];
const AR_ONES_F = ["", "واحدة", "اثنتان", "ثلاث", "أربع", "خمس", "ست", "سبع", "ثماني", "تسع"];
const AR_TEENS_M = ["عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
const AR_TEENS_F = ["عشر", "إحدى عشرة", "اثنتا عشرة", "ثلاث عشرة", "أربع عشرة", "خمس عشرة", "ست عشرة", "سبع عشرة", "ثماني عشرة", "تسع عشرة"];
const AR_TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
const AR_HUNDREDS = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];
const AR_SCALES: [string, string, string, string][] = [
  ["ألف", "ألفان", "آلاف", "ألفًا"],
  ["مليون", "مليونان", "ملايين", "مليونًا"],
  ["مليار", "ملياران", "مليارات", "مليارًا"],
];

function arBelowThousand(n: number, feminine: boolean): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(AR_HUNDREDS[h]);
  if (rest) {
    const ones = feminine ? AR_ONES_F : AR_ONES_M;
    if (rest < 10) parts.push(ones[rest]);
    else if (rest < 20) parts.push((feminine ? AR_TEENS_F : AR_TEENS_M)[rest - 10]);
    else {
      const u = rest % 10;
      const t = Math.floor(rest / 10);
      parts.push(u ? `${ones[u]} و${AR_TENS[t]}` : AR_TENS[t]);
    }
  }
  return parts.join(" و");
}

/** The form of a counted noun after n (the last two digits decide). */
function arForm(n: number, forms: [string, string, string, string]): string {
  const last = n % 100;
  if (last >= 3 && last <= 10) return forms[2];
  if (last >= 11) return forms[3];
  return forms[0];
}

function arCount(n: number, noun: Noun): string {
  if (n === 1) return `${noun.forms[0]} ${noun.feminine ? "واحدة" : "واحد"}`;
  if (n === 2) return noun.forms[1];
  const groups: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) groups.push(rest % 1000);
  const words: string[] = [];
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    if (!g) continue;
    if (i === 0) {
      words.push(arBelowThousand(g, Boolean(noun.feminine)));
    } else {
      const scale = AR_SCALES[i - 1];
      if (g === 1) words.push(scale[0]);
      else if (g === 2) words.push(scale[1]);
      else {
        // straight before the counted noun ("أحد عشر ألفَ جنيه") the 11-99 form loses its tanween
        const lowerAreZero = groups.slice(0, i).every((value) => value === 0);
        const form = arForm(g, scale);
        words.push(`${arBelowThousand(g, false)} ${lowerAreZero && form === scale[3] ? scale[0] : form}`);
      }
    }
  }
  return `${words.join(" و")} ${arForm(n, noun.forms)}`;
}

// --- English ------------------------------------------------------------------------------------
const EN_ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const EN_SCALES = ["", "thousand", "million", "billion"];

function enBelowThousand(n: number): string {
  const parts: string[] = [];
  if (n >= 100) parts.push(`${EN_ONES[Math.floor(n / 100)]} hundred`);
  const rest = n % 100;
  if (rest) parts.push(rest < 20 ? EN_ONES[rest] : `${EN_TENS[Math.floor(rest / 10)]}${rest % 10 ? `-${EN_ONES[rest % 10]}` : ""}`);
  return parts.join(" and ");
}

function enNumber(n: number): string {
  if (n === 0) return "zero";
  const words: string[] = [];
  let scale = 0;
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000), scale += 1) {
    const g = rest % 1000;
    if (g) words.unshift(`${enBelowThousand(g)}${EN_SCALES[scale] ? ` ${EN_SCALES[scale]}` : ""}`);
  }
  return words.join(" ");
}

/** "فقط ... لا غير" in Arabic, "... only" otherwise. Returns "" for an amount it cannot write. */
export function amountInWords(amount: number | string, currencyCode: string, language: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0 || value >= 1e12) return "";
  const code = (currencyCode || "").toUpperCase();
  const currency = CURRENCIES[code];
  const minorUnits = currency?.minorUnits ?? 100;
  const scaled = Math.round(value * minorUnits);
  const major = Math.floor(scaled / minorUnits);
  const minor = scaled % minorUnits;

  if (language === "ar") {
    const majorNoun: Noun = currency?.ar.major ?? { forms: [code, code, code, code] };
    const parts: string[] = [];
    if (major > 0) parts.push(arCount(major, majorNoun));
    if (minor > 0) parts.push(currency?.ar.minor ? arCount(minor, currency.ar.minor) : `${arBelowThousand(minor, false)} من ${minorUnits}`);
    if (!parts.length) parts.push(`صفر ${majorNoun.forms[0]}`);
    return `فقط ${parts.join(" و")} لا غير`;
  }

  const [one, many] = currency?.en.major ?? [code, code];
  const parts = [`${enNumber(major)} ${major === 1 ? one : many}`];
  if (minor > 0) {
    const [minorOne, minorMany] = currency?.en.minor ?? ["", ""];
    parts.push(currency?.en.minor ? `${enNumber(minor)} ${minor === 1 ? minorOne : minorMany}` : `${minor}/${minorUnits}`);
  }
  const text = `${parts.join(" and ")} only`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The currency's name and code for a payslip's net band: ["جنيه", "EGP"]; the code twice when unknown. */
export function currencyLabel(currencyCode: string): [string, string] {
  const code = (currencyCode || "").toUpperCase();
  return [CURRENCIES[code]?.ar.major.forms[0] ?? code, code];
}
