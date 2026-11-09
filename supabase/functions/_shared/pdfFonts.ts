// Shared by the server-side PDFs: the Noto fonts (fetched once per worker and cached), the
// PROSM logo, and base64 for email attachments. Extracted from licenseEmail.ts (2026-11-08).
import { subsetFont } from "./fontSubset.ts";
import { scriptsNeeded } from "./pdfText.ts";

const NOTO = "https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts";
const FONTS = {
  latin: [`${NOTO}/NotoSans/hinted/ttf/NotoSans-Regular.ttf`, `${NOTO}/NotoSans/hinted/ttf/NotoSans-Bold.ttf`],
  // IBM Plex Sans Arabic (the app's own Arabic face): its letters carry their dots, so the PDF shows
  // them in place - Noto Naskh draws dots as marks that pdf-lib cannot position (owner 2026-11-09).
  arabic: ["https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/ibmplexsansarabic/IBMPlexSansArabic-Regular.ttf", "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/ibmplexsansarabic/IBMPlexSansArabic-Bold.ttf"],
  // Noto Sans SC, whole TrueType files (Google Fonts serves them to plain clients).
  cjk: [
    "https://fonts.gstatic.com/s/notosanssc/v41/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYw.ttf",
    "https://fonts.gstatic.com/s/notosanssc/v41/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaGzjCnYw.ttf",
  ],
} as const;
const LOGO = "https://time.prosm.net/prosm-logo.png";

export type FontPair = { regular: Uint8Array; bold: Uint8Array; presubset?: boolean };
const fontCache: Partial<Record<keyof typeof FONTS, FontPair>> = {};
let logoCache: Uint8Array | null | undefined;

export async function bytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function font(kind: keyof typeof FONTS): Promise<FontPair> {
  if (!fontCache[kind]) {
    const [regular, bold] = await Promise.all(FONTS[kind].map(bytes));
    fontCache[kind] = { regular, bold };
  }
  return fontCache[kind]!;
}

/** The fonts a page with these texts needs (Chinese cut down to its characters first). */
export async function fontsFor(pageTexts: string[]): Promise<{ latin: FontPair; arabic: FontPair | null; cjk: FontPair | null }> {
  const needed = scriptsNeeded(pageTexts);
  let cjk: FontPair | null = null;
  if (needed.cjk) {
    const full = await font("cjk");
    const chars = pageTexts.join("");
    cjk = { regular: await subsetFont(full.regular, chars), bold: await subsetFont(full.bold, chars), presubset: true };
  }
  return { latin: await font("latin"), arabic: needed.arabic ? await font("arabic") : null, cjk };
}

export async function prosmLogo(): Promise<Uint8Array | null> {
  if (logoCache === undefined) logoCache = await bytes(LOGO).catch(() => null);
  return logoCache;
}

export function base64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}
