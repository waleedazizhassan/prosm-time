import logoUrl from "../../../assets/brand/prosm-time-logo.png";

// PROSM Connect media helpers (owner 2026-11-13): pictures are made smaller before sending, voice is recorded only
// when the person presses the microphone (the permission is asked then), and the verified photo carries its proof
// printed into its own pixels - the PROSM Time logo (owner: our own logo, not the PDF's), the site, the server's
// time, the coordinates and their accuracy, who took it, inside or outside the site, and the proof code.

/** A photo made smaller (longest side 1600 px, JPEG) - files other than images go as they are. */
export async function compressImage(file: Blob, maxSide = 1600, quality = 0.82): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  return out && out.size < file.size ? out : file;
}

/** Records the microphone until stopped; the browser asks for the permission on the first press. */
export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private startedAt = 0;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type, audioBitsPerSecond: 24000 } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.startedAt = performance.now();
    this.recorder.start(250);
  }

  async stop(): Promise<{ blob: Blob; durationMs: number } | null> {
    const recorder = this.recorder;
    if (!recorder) return null;
    const done = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    const durationMs = Math.round(performance.now() - this.startedAt);
    const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
    this.recorder = null;
    return durationMs < 400 || blob.size === 0 ? null : { blob, durationMs };
  }

  cancel() {
    this.recorder?.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.recorder = null;
  }
}

export interface PhotoProof {
  code: string;
  serverTime: string;
  siteName: string | null;
  inside: boolean;
  name: string;
  ext: string | null;
  lat: number;
  lng: number;
  accuracy: number | null;
}

let logo: Promise<HTMLImageElement | null> | null = null;
function loadLogo() {
  if (!logo) {
    logo = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = logoUrl;
    });
  }
  return logo;
}

/** Prints the proof into the photo's pixels and returns the stamped JPEG. */
export async function stampPhoto(source: CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number }, proof: PhotoProof, labels: { inside: string; outside: string; time: string }): Promise<Blob> {
  const width = (source.videoWidth || source.width || 1280) as number;
  const height = (source.videoHeight || source.height || 720) as number;
  const scale = Math.min(1, 1920 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  const unit = Math.max(12, Math.round(canvas.width / 60));
  const band = unit * 7.2;
  const gradient = ctx.createLinearGradient(0, canvas.height - band * 1.25, 0, canvas.height);
  gradient.addColorStop(0, "rgba(4,9,20,0)");
  gradient.addColorStop(0.3, "rgba(4,9,20,0.82)");
  gradient.addColorStop(1, "rgba(4,9,20,0.94)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, canvas.height - band * 1.25, canvas.width, band * 1.25);

  const pad = unit;
  const baseY = canvas.height - pad;
  const image = await loadLogo();
  const logoSize = unit * 3.4;
  ctx.direction = "rtl";
  if (image) ctx.drawImage(image, canvas.width - pad - logoSize, baseY - logoSize - unit * 1.3, logoSize, logoSize);
  ctx.fillStyle = "#e9eefb";
  ctx.textAlign = "center";
  ctx.font = `700 ${Math.round(unit * 0.75)}px system-ui, sans-serif`;
  ctx.fillText("PROSM Time", canvas.width - pad - logoSize / 2, baseY - unit * 0.2);

  const textRight = canvas.width - pad * 2 - logoSize;
  ctx.textAlign = "right";
  ctx.font = `700 ${Math.round(unit * 1.25)}px system-ui, sans-serif`;
  ctx.fillText(proof.siteName ?? "—", textRight, baseY - unit * 4.2);
  ctx.font = `500 ${Math.round(unit * 0.9)}px system-ui, sans-serif`;
  ctx.fillStyle = "#c9d5ef";
  ctx.fillText(labels.time, textRight, baseY - unit * 2.8);
  ctx.direction = "ltr";
  ctx.textAlign = "right";
  ctx.fillText(`${proof.lat.toFixed(5)}, ${proof.lng.toFixed(5)}${proof.accuracy != null ? ` · ±${Math.round(proof.accuracy)} m` : ""}`, textRight, baseY - unit * 1.5);
  ctx.direction = "rtl";
  ctx.fillText(`${proof.name}${proof.ext ? ` · ${proof.ext}` : ""}`, textRight, baseY - unit * 0.2);

  // inside (green) / outside (amber) and the proof code, on the other side
  const badge = proof.inside ? labels.inside : labels.outside;
  ctx.font = `700 ${Math.round(unit * 0.85)}px system-ui, sans-serif`;
  const badgeWidth = ctx.measureText(badge).width + unit * 1.4;
  const bx = pad;
  const by = baseY - unit * 3.2;
  ctx.fillStyle = proof.inside ? "rgba(34,197,94,0.25)" : "rgba(242,179,61,0.25)";
  roundRect(ctx, bx, by, badgeWidth, unit * 1.5, unit * 0.75);
  ctx.fill();
  ctx.fillStyle = proof.inside ? "#4ade80" : "#f2b33d";
  ctx.textAlign = "center";
  ctx.fillText(badge, bx + badgeWidth / 2, by + unit * 1.05);
  ctx.direction = "ltr";
  ctx.fillStyle = "#93a2c4";
  ctx.font = `600 ${Math.round(unit * 0.8)}px ui-monospace, monospace`;
  ctx.fillText(`#${proof.code}`, bx + badgeWidth / 2, baseY - unit * 0.2);

  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("stamp failed"))), "image/jpeg", 0.88));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
