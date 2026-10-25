import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

// PROSM Time - § live UX review, user-directed real bug: "PDFs (and
// everything else) don't export from mobile at all." Every generated-
// file download in this app (PDF, CSV) used a blob URL + a synthetic
// `<a download>` click - a mechanism real browsers handle natively,
// but that silently does nothing inside a Capacitor Android WebView
// (there is no OS-level download handler wired up to an embedded
// WebView the way there is in a real browser tab). On native, this
// writes the file to the app's own cache directory via
// @capacitor/filesystem and hands it to the OS share sheet via
// @capacitor/share instead - the standard, correct pattern for "give
// the user a generated file" in a Capacitor app (save to Drive/Files,
// open in a viewer, send via WhatsApp, etc.). Web behavior (the
// original blob-URL download) is completely unchanged.
export default async function saveGeneratedFile(filename: string, blob: Blob): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return;
  }

  // v2.3.43 step 18 (item 16): a long report can be tens of MB - written in
  // pieces so no single base64 string crosses the native bridge whole (one
  // huge string ran phones out of memory).
  const ranges = chunkRanges(blob.size, WRITE_CHUNK_BYTES);
  let uri = "";
  for (const [index, [start, end]] of ranges.entries()) {
    const data = await blobToBase64(blob.slice(start, end));
    if (index === 0) uri = (await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache })).uri;
    else await Filesystem.appendFile({ path: filename, data, directory: Directory.Cache });
  }
  try {
    await Share.share({ title: filename, url: uri });
  } catch (error) {
    // Closing the share sheet without choosing an app is not a failure.
    if (!isShareCancel(error)) throw error;
  }
}

// A multiple of 3 so each piece is whole base64 (no padding mid-file).
const WRITE_CHUNK_BYTES = 3 * 1024 * 1024;

export function chunkRanges(size: number, chunk: number): [number, number][] {
  if (size <= 0) return [[0, 0]];
  const ranges: [number, number][] = [];
  for (let start = 0; start < size; start += chunk) ranges.push([start, Math.min(size, start + chunk)]);
  return ranges;
}

export function isShareCancel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /cancel/i.test(message);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
