import { useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Camera, Mic, MicOff, MessageSquareText, Phone, PhoneOff, RefreshCcw, Video, VideoOff } from "lucide-react";

import type { ConnectPerson } from "../../core/repositories/ConnectRepository";
import Avatar from "../../components/common/Avatar";
import type { CallSession } from "./engine/CallSession";
import { ConnectEngine } from "./engine/ConnectEngine";
import { formatDuration } from "./engine/media";
import GlassButton from "./GlassButton";
import styles from "./CallScreen.module.css";

// PROSM Connect - the call on the whole screen (owner 2026-11-13): coming in (decline, reply with a message, answer),
// in the call (the network's strength for both, a small picture of oneself, mute, camera off, flip, a verified photo
// from the video, end), "reconnecting..." when the network changes, and - when the call cannot get through - the
// reason and "send a voice message" at once.
export default function CallScreen({ session, people, onClose }: { session: CallSession; people: Map<string, ConnectPerson>; onClose: () => void }) {
  const { t } = useTranslation("connect");
  const navigate = useNavigate();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(Date.now());
  const [quickReplies, setQuickReplies] = useState(false);
  const person = people.get(session.peerId);

  useEffect(() => session.onChange(refresh), [session]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (remoteVideo.current && remoteVideo.current.srcObject !== session.remote) remoteVideo.current.srcObject = session.remote;
    if (remoteAudio.current && remoteAudio.current.srcObject !== session.remote) remoteAudio.current.srcObject = session.remote;
    if (localVideo.current && session.local && localVideo.current.srcObject !== session.local) localVideo.current.srcObject = session.local;
  });
  // the ringtone while it rings (an incoming call), quiet otherwise
  useEffect(() => {
    if (session.state !== "ringing") return undefined;
    const ctx = new AudioContext();
    let stop = false;
    const ring = () => {
      if (stop) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 480;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 1.2);
      window.setTimeout(ring, 3000);
    };
    ring();
    navigator.vibrate?.([600, 400, 600]);
    return () => {
      stop = true;
      void ctx.close();
    };
  }, [session.state]);

  const name = person?.fullName ?? "";
  const ended = ["ended", "missed", "rejected", "busy"].includes(session.state);
  const video = session.media === "video";
  const showRemoteVideo = video && session.remote.getVideoTracks().length > 0 && !session.remoteVideoOff && session.state === "connected";

  useEffect(() => {
    if (!ended) return undefined;
    const timer = window.setTimeout(onClose, 1800);
    return () => window.clearTimeout(timer);
  }, [ended, onClose]);

  const replyWith = async (text: string) => {
    const conversation = await ConnectEngine.directWith(session.peerId);
    if (conversation) await ConnectEngine.send(conversation, "message", { body: text, otherUserId: session.peerId });
    await session.decline();
    onClose();
  };

  const sendVoiceInstead = async () => {
    const conversation = await ConnectEngine.directWith(session.peerId);
    onClose();
    if (conversation) navigate(`/connect?c=${encodeURIComponent(conversation)}&voice=1`);
  };

  const where = person ? (person.presence === "out" ? t("presence.out") : person.currentSiteName ?? t(`presence.${person.presence}`)) : "";

  return (
    <div className={styles.screen} role="dialog" aria-modal="true" aria-label={t("call.label", { name })}>
      <audio ref={remoteAudio} autoPlay />
      {showRemoteVideo ? <video ref={remoteVideo} className={styles.remote} autoPlay playsInline muted /> : null}
      <div className={showRemoteVideo ? `${styles.overlay} ${styles.overlayVideo}` : styles.overlay}>
        <header className={styles.top}>
          <span className={styles.pill}>{name}{session.startedAt ? ` · ${formatDuration(now - session.startedAt)}` : ""}</span>
          {session.state === "connected" || session.state === "reconnecting" ? (
            <span className={styles.bars} aria-label={t("call.network", { level: session.quality.level })}>
              {[1, 2, 3, 4].map((n) => <i key={n} className={n <= session.quality.level ? styles.barOn : undefined} style={{ height: 3 + n * 3 }} />)}
            </span>
          ) : null}
        </header>

        {video && session.local && !session.localVideoOff && session.state !== "ringing" ? <video ref={localVideo} className={styles.pip} autoPlay playsInline muted /> : null}

        {!showRemoteVideo ? (
          <div className={styles.who}>
            <span className={session.state === "ringing" || session.state === "calling" ? `${styles.ring} ${styles.ringing}` : styles.ring}>
              <Avatar name={name} url={person?.avatarUrl ?? null} size="lg" />
            </span>
            <h2 className={styles.name}>{name}</h2>
            <p className={styles.sub}>{t(`call.state.${session.state}`)}{session.remoteVideoOff && video ? ` · ${t("call.theirVideoOff")}` : ""}</p>
            {where ? <span className={styles.site}>{where}</span> : null}
          </div>
        ) : null}

        {session.state === "reconnecting" ? <div className={styles.banner}>{t("call.reconnecting")}</div> : null}
        {session.localVideoOff && video && session.state === "connected" ? <div className={styles.banner}>{t("call.weakVideoOff")}</div> : null}

        {session.state === "failed" ? (
          <div className={styles.failed}>
            <p>{t("call.failedText")}</p>
            <div className={styles.row}>
              <button type="button" className={styles.primary} onClick={() => void sendVoiceInstead()}><Mic size={18} aria-hidden="true" /> {t("call.sendVoice")}</button>
              <button type="button" className={styles.secondary} onClick={onClose}>{t("call.close")}</button>
            </div>
          </div>
        ) : session.state === "ringing" ? (
          <>
            {quickReplies ? (
              <div className={styles.replies}>
                {(["atSite", "callLater", "inMeeting"] as const).map((key) => (
                  <button key={key} type="button" onClick={() => void replyWith(t(`call.reply.${key}`))}>{t(`call.reply.${key}`)}</button>
                ))}
              </div>
            ) : null}
            <div className={styles.answerRow}>
              <span className={styles.action}><GlassButton label={t("call.decline")} tone="danger" size="large" onClick={() => void session.decline().then(onClose)}><PhoneOff size={24} /></GlassButton>{t("call.decline")}</span>
              <span className={styles.action}><GlassButton label={t("call.replyMessage")} size="large" onClick={() => setQuickReplies((v) => !v)}><MessageSquareText size={24} /></GlassButton>{t("call.replyMessage")}</span>
              <span className={styles.action}><GlassButton label={t("call.answer")} tone="success" size="large" onClick={() => void session.answer()}>{video ? <Video size={24} /> : <Phone size={24} />}</GlassButton>{t("call.answer")}</span>
            </div>
          </>
        ) : !ended ? (
          <div className={styles.controls}>
            <GlassButton label={session.muted ? t("call.unmute") : t("call.mute")} onClick={() => session.toggleMute()}>{session.muted ? <MicOff size={20} /> : <Mic size={20} />}</GlassButton>
            {video ? <GlassButton label={session.localVideoOff ? t("call.videoOn") : t("call.videoOff")} onClick={() => session.toggleVideo()}>{session.localVideoOff ? <VideoOff size={20} /> : <Video size={20} />}</GlassButton> : null}
            {video ? <GlassButton label={t("call.flip")} onClick={() => void session.flipCamera()}><RefreshCcw size={20} /></GlassButton> : null}
            {video && showRemoteVideo ? <GlassButton label={t("call.verifiedPhoto")} onClick={() => void ConnectEngine.directWith(session.peerId).then((c) => c && navigate(`/connect?c=${encodeURIComponent(c)}&camera=1`))}><Camera size={20} /></GlassButton> : null}
            <GlassButton label={t("call.end")} tone="danger" onClick={() => void session.hangup()}><PhoneOff size={20} /></GlassButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}
