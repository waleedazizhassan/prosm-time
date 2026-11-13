// Owner 2026-11-12: "when I add a work site I can paste a map link someone sent me, and that is the site".
// Reads a position from what was pasted: a Google Maps link (…/@lat,lng…, …!3dlat!4dlng…, ?q=lat,lng,
// ?query=, ?ll=, ?destination=), a geo: link, or the coordinates themselves ("29.94058, 30.89010",
// Arabic digits and comma too). A short shared link (maps.app.goo.gl, goo.gl/maps) carries no position
// until it is opened - that is reported as "short" so the caller can resolve it first.

export type MapLinkResult = { latitude: number; longitude: number } | "short" | null;

// Arabic-Indic (U+0660..) and extended Arabic-Indic (U+06F0..) digits
const ARABIC_ZERO = 0x0660;
const EXTENDED_ZERO = 0x06f0;

function normalise(text: string): string {
  return text
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - ARABIC_ZERO))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - EXTENDED_ZERO))
    .replace(/\u066b/g, ".")
    .replace(/[\u060c\u061b]/g, ",")
    .trim();
}

function valid(lat: number, lng: number): { latitude: number; longitude: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(lng * 1e6) / 1e6 };
}

const PAIR = String.raw`(-?\d{1,3}(?:\.\d+)?)\s*,\s*\+?(-?\d{1,3}(?:\.\d+)?)`;

export function isShortMapLink(text: string): boolean {
  return /^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\//i.test(text.trim());
}

// Owner 2026-11-13: what the phone's "Share" gives is often the place's name with the link after it
// ("Amon Factory\nhttps://maps.app.goo.gl/..."). The link is taken out of the text; text without a link
// (the coordinates themselves) is kept as it is.
export function extractMapLink(input: string): string {
  const text = input.trim();
  const url = text.match(/https?:\/\/[^\s<>"']+/i) ?? text.match(/(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\/[^\s<>"']+/i);
  return url ? url[0].replace(/[).,;\]]+$/, "") : text;
}

export function parseMapLink(input: string): MapLinkResult {
  const text = normalise(decodeURIComponentSafe(extractMapLink(input)));
  if (!text) return null;

  // the place itself (!3d lat !4d lng) is more exact than the map's centre (@lat,lng)
  const place = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (place) return valid(Number(place[1]), Number(place[2]));

  const param = text.match(new RegExp(String.raw`[?&](?:q|query|ll|destination|daddr|center|sll)=(?:loc:)?` + PAIR, "i"));
  if (param) return valid(Number(param[1]), Number(param[2]));

  const at = text.match(new RegExp("@" + PAIR));
  if (at) return valid(Number(at[1]), Number(at[2]));

  const geo = text.match(new RegExp("^geo:" + PAIR, "i"));
  if (geo) return valid(Number(geo[1]), Number(geo[2]));

  // just the numbers
  const bare = text.match(new RegExp("^" + PAIR + "$"));
  if (bare) return valid(Number(bare[1]), Number(bare[2]));

  if (isShortMapLink(text)) return "short";

  // a link whose path is "lat,lng" (e.g. …/maps/place/29.94,30.89)
  const path = text.match(new RegExp(String.raw`/` + PAIR + String.raw`(?:[/?#]|$)`));
  if (path) return valid(Number(path[1]), Number(path[2]));
  return null;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
