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

  const base64 = await blobToBase64(blob);
  const written = await Filesystem.writeFile({ path: filename, data: base64, directory: Directory.Cache });
  await Share.share({ title: filename, url: written.uri });
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
