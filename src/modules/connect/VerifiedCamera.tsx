import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Camera, RefreshCcw, X } from "lucide-react";

import { getCurrentPosition } from "../../core/utils/geo";
import { formatDateTime } from "../../core/utils/formatDate";
import { ConnectEngine } from "./engine/ConnectEngine";
import { sha256Hex, stampPhoto, type PhotoProof } from "./engine/media";
import GlassButton from "./GlassButton";
import styles from "./VerifiedCamera.module.css";

// PROSM Connect - the verified photo (owner 2026-11-13). The app's own camera only - never the gallery, never opened
// remotely: the person presses. Before the stamp the server gives its time, the nearest site and whether the phone is
// inside it, and a code; the stamp is printed into the photo's pixels; its SHA-256 is recorded with the code, so the
// company can later check it was not changed. The photo itself is never kept on the server.
export default function VerifiedCamera({ onDone, onClose }: { onDone: (photo: Blob, code: string) => void; onClose: () => void }) {
  const { t, i18n } = useTranslation("connect");
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    let current: MediaStream | null = null;
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        if (!live) return s.getTracks().forEach((tr) => tr.stop());
        current = s;
        setStream(s);
        if (video.current) video.current.srcObject = s;
      })
      .catch(() => setError(t("camera.noCamera")));
    return () => {
      live = false;
      current?.getTracks().forEach((tr) => tr.stop());
    };
  }, [facing, t]);

  const capture = async () => {
    if (!video.current || !stream) return;
    setBusy(true);
    setError("");
    try {
      const position = await getCurrentPosition({ highAccuracy: true, timeoutMs: 15000 });
      const { data, error: proofError } = await ConnectEngine.supabase.rpc("prosm_time_connect_photo_proof", { p_lat: position.latitude, p_lng: position.longitude, p_accuracy: position.accuracyMeters ?? null });
      if (proofError || !data) throw new Error(proofError?.message ?? "proof");
      const proof = { ...(data as Omit<PhotoProof, "lat" | "lng" | "accuracy">), lat: position.latitude, lng: position.longitude, accuracy: position.accuracyMeters ?? null } as PhotoProof;
      const blob = await stampPhoto(video.current, proof, {
        inside: t("camera.inside"), outside: t("camera.outside"),
        time: formatDateTime(proof.serverTime, i18n.language),
      });
      await ConnectEngine.supabase.rpc("prosm_time_connect_photo_sealed", { p_code: proof.code, p_sha256: await sha256Hex(blob) });
      onDone(blob, proof.code);
    } catch {
      setError(t("camera.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.screen} role="dialog" aria-modal="true" aria-label={t("camera.title")}>
      <video ref={video} className={styles.view} autoPlay playsInline muted />
      <header className={styles.top}>
        <GlassButton label={t("camera.close")} size="small" onClick={onClose}><X size={16} /></GlassButton>
        <span className={styles.badge}>{t("camera.title")}</span>
        <GlassButton label={t("camera.flip")} size="small" onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}><RefreshCcw size={16} /></GlassButton>
      </header>
      <p className={styles.hint}>{error || t("camera.hint")}</p>
      <div className={styles.shutterRow}>
        <button type="button" className={styles.shutter} onClick={() => void capture()} disabled={busy || !stream} aria-label={t("camera.take")}>
          <Camera size={28} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
