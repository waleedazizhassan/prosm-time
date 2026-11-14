import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bell, Music, PhoneIncoming, Play, Vibrate, Volume2 } from "lucide-react";

import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import { RING_TONES, loadSoundPrefs, messageAlert, previewTone, saveSoundPrefs, type SoundPrefs } from "./engine/sounds";
import styles from "./SoundSettings.module.css";

type Toggle = "callVibrate" | "messageSound" | "messageVibrate";

// PROSM Connect - sound and vibration (owner 2026-11-14): the ringtone and its loudness, vibrating for calls, and the
// chime / vibration of a new message. Kept on this device (each phone rings its own way).
export default function SoundSettings({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("connect");
  const [prefs, setPrefs] = useState<SoundPrefs>(() => loadSoundPrefs());
  const stopPreview = useRef<(() => void) | null>(null);

  const update = (patch: Partial<SoundPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveSoundPrefs(next);
    return next;
  };
  const preview = (next: SoundPrefs) => {
    stopPreview.current?.();
    stopPreview.current = previewTone(next.tone, next.volume);
  };
  useEffect(() => () => stopPreview.current?.(), []);

  const onToggle = (key: Toggle, checked: boolean) => {
    const next = update({ [key]: checked });
    if (!checked) return;
    // let the person hear / feel what they just turned on
    if (key === "callVibrate") navigator.vibrate?.([400, 200, 400]);
    else messageAlert({ ...next, messageSound: key === "messageSound", messageVibrate: key === "messageVibrate" });
  };

  const toggle = (key: Toggle, icon: ReactNode) => (
    <label className={styles.row}>
      <span className={styles.label}>{icon}{t(`sound.${key}`)}</span>
      <input type="checkbox" role="switch" className={styles.switch} checked={prefs[key]} onChange={(e) => onToggle(key, e.target.checked)} />
    </label>
  );

  const percent = Math.round(prefs.volume * 100);
  return (
    <Modal isOpen onClose={onClose} title={t("sound.title")} size="sm" footer={<Button variant="ghost" onClick={onClose}>{t("storage.close")}</Button>}>
      <h3 className={styles.group}><PhoneIncoming size={15} aria-hidden="true" />{t("sound.calls")}</h3>
      <div className={styles.tones} role="radiogroup" aria-label={t("sound.tone")}>
        {RING_TONES.map((tone) => (
          <button key={tone} type="button" role="radio" aria-checked={prefs.tone === tone}
            className={prefs.tone === tone ? `${styles.tone} ${styles.toneOn}` : styles.tone}
            onClick={() => preview(update({ tone }))}>
            <Music size={16} aria-hidden="true" />
            <span>{t(`sound.tones.${tone}`)}</span>
            <Play size={13} aria-hidden="true" className={styles.play} />
          </button>
        ))}
      </div>
      <label className={styles.row}>
        <span className={styles.label}><Volume2 size={16} aria-hidden="true" />{t("sound.volume")}</span>
        <input type="range" min={0} max={100} step={5} className={styles.range} value={percent}
          aria-valuetext={percent === 0 ? t("sound.silent") : `${percent}%`}
          onChange={(e) => update({ volume: Number(e.target.value) / 100 })}
          onPointerUp={() => preview(prefs)} onKeyUp={() => preview(prefs)} />
        <b className={styles.value}>{percent === 0 ? t("sound.silent") : `${percent}%`}</b>
      </label>
      {toggle("callVibrate", <Vibrate size={16} aria-hidden="true" />)}

      <h3 className={styles.group}><Bell size={15} aria-hidden="true" />{t("sound.messages")}</h3>
      {toggle("messageSound", <Volume2 size={16} aria-hidden="true" />)}
      {toggle("messageVibrate", <Vibrate size={16} aria-hidden="true" />)}

      <p className={styles.note}>{t("sound.note")}</p>
    </Modal>
  );
}
