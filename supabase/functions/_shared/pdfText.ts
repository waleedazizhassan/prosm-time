// Shared by the server-side PDFs (the licence, the payslip): a line of text is cut into script
// runs - Arabic, Chinese, and the rest (Latin, Cyrillic, digits) - each drawn in its own font;
// fontkit joins Arabic letters and lays an Arabic run out right to left itself. An Arabic page
// reads from the right, the others from the left. Extracted from licensePdfCore.ts (2026-11-08)
// so the payslip uses exactly the same, already-proven text handling.
// deno-lint-ignore-file no-explicit-any

export const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
export const CJK = /[⺀-⿟　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;
// The hyphen and the middle dot are not in the Arabic font: they always take the Latin one.
const NEUTRAL = /[\s:.,;!?()\/،؛]/;
export type Script = "arabic" | "cjk" | "latin";
export type Weight = "regular" | "bold";

/** Which extra fonts these texts need - so a caller fetches only those. */
export function scriptsNeeded(texts: string[]): { arabic: boolean; cjk: boolean } {
  const all = texts.join(" ");
  return { arabic: ARABIC.test(all), cjk: CJK.test(all) };
}

export function runsOf(text: string): { run: string; script: Script }[] {
  const chars = [...text];
  const strong: (Script | null)[] = chars.map((ch) => (ARABIC.test(ch) ? "arabic" : CJK.test(ch) ? "cjk" : NEUTRAL.test(ch) ? null : "latin"));
  // A space or mark between two letters of one script belongs to that script; anywhere else,
  // to the Latin font.
  const scripts = strong.map((s, i) => {
    if (s) return s;
    let before: Script | null = null;
    for (let j = i - 1; j >= 0 && !before; j--) before = strong[j];
    let after: Script | null = null;
    for (let j = i + 1; j < chars.length && !after; j++) after = strong[j];
    return before && before === after ? before : "latin";
  });
  const runs: { run: string; script: Script }[] = [];
  chars.forEach((ch, i) => {
    const last = runs[runs.length - 1];
    if (last && last.script === scripts[i]) last.run += ch;
    else runs.push({ run: ch, script: scripts[i] });
  });
  return runs;
}

export type FontSet = Record<Script, Record<Weight, any>>;

/** Drawing helpers for one page: widths and text placed from the left, the right, or the page's start/end side. */
export function textKit(page: any, fontFor: FontSet, rtl: boolean) {
  const W = page.getWidth();
  // In a right-to-left line, the spaces and marks a left-to-right run starts or ends with sit on
  // the Arabic side: "رقم الترخيص: X" shows as "X :رقم الترخيص".
  const flip = (run: string) => {
    const match = run.match(/^([\s:.,;!?\-]*)([\s\S]*?)([\s:.,;!?\-]*)$/);
    if (!match) return run;
    const [, lead, core, trail] = match;
    return [...trail].reverse().join("") + core + [...lead].reverse().join("");
  };
  // A line containing Arabic is laid out right to left even on a left-to-right page.
  const lineRtl = (text: string) => rtl || ARABIC.test(text);
  const laidOut = (text: string) => {
    const runs = runsOf(text);
    if (!lineRtl(text) || !runs.some((r) => r.script === "arabic")) return runs;
    return runs.map((r) => (r.script === "arabic" ? r : { ...r, run: flip(r.run) }));
  };
  const widthOf = (text: string, size: number, weight: Weight = "regular") =>
    laidOut(text).reduce((sum, { run, script }) => sum + fontFor[script][weight].widthOfTextAtSize(run, size), 0);
  const drawFrom = (text: string, xLeft: number, y: number, size: number, weight: Weight, color: any) => {
    const runs = laidOut(text);
    let x = xLeft;
    for (const { run, script } of lineRtl(text) && runs.some((r) => r.script === "arabic") ? [...runs].reverse() : runs) {
      const font = fontFor[script][weight];
      page.drawText(run, { x, y, size, font, color });
      x += font.widthOfTextAtSize(run, size);
    }
  };
  const left = (text: string, xLeft: number, y: number, size: number, weight: Weight, color: any) => drawFrom(text, xLeft, y, size, weight, color);
  const right = (text: string, xRight: number, y: number, size: number, weight: Weight, color: any) => drawFrom(text, xRight - widthOf(text, size, weight), y, size, weight, color);
  const center = (text: string, xCenter: number, y: number, size: number, weight: Weight, color: any) => drawFrom(text, xCenter - widthOf(text, size, weight) / 2, y, size, weight, color);
  /** The largest size, from `size` down to 7, at which the text fits in maxWidth. */
  const fit = (text: string, maxWidth: number, size: number, weight: Weight = "regular") => {
    let s = size;
    while (s > 7 && widthOf(text, s, weight) > maxWidth) s -= 0.5;
    return s;
  };
  return { W, widthOf, left, right, center, fit, start: (text: string, inset: number, y: number, size: number, weight: Weight, color: any) =>
    rtl ? right(text, W - inset, y, size, weight, color) : left(text, inset, y, size, weight, color),
    end: (text: string, inset: number, y: number, size: number, weight: Weight, color: any) =>
    rtl ? left(text, inset, y, size, weight, color) : right(text, W - inset, y, size, weight, color) };
}
