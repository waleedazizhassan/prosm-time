import { useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Circle, Hand, LayoutGrid, MessageSquare, Mic, MicOff, MonitorUp, PhoneOff, Pin, Users, Video, VideoOff, VolumeX } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import type { ConnectPerson } from "../../core/repositories/ConnectRepository";
import Avatar from "../../components/common/Avatar";
import type { MeetingSession } from "./engine/MeetingSession";
import { ConnectEngine } from "./engine/ConnectEngine";
import GlassButton from "./GlassButton";
import styles from "./MeetingScreen.module.css";

type Layout = "host" | "share" | "grid";

// PROSM Connect - a small meeting (owner 2026-11-13): three layouts chosen by the app - the host in the middle with the
// others around (up to 7 around with sound only), screen sharing big with the team in a strip, and everyone the same
// size; the speaker gets a green ring. The host can mute everyone, pin someone, and stop recording; anyone can raise a
// hand and write in the meeting's chat. "<name> is recording the meeting" shows to everyone - a red strip on top - for
// as long as it lasts, also to someone who joins late; the recording stays on the recorder's own device.
export default function MeetingScreen({ session, people, onClose }: { session: MeetingSession; people: Map<string, ConnectPerson>; onClose: () => void }) {
  const { t } = useTranslation("connect");
  const { profile } = useAuth();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [chatOpen, setChatOpen] = useState(false);
  const [text, setText] = useState("");
  const [layoutChoice, setLayoutChoice] = useState<Layout | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const recorders = useRef(new Set<string>());

  useEffect(() => session.onChange(refresh), [session]);
  useEffect(() => {
    if (session.ended) onClose();
  });
  // the recording saved on this device (stays local - never uploaded)
  useEffect(() => {
    session.onRecorded = (blob) => {
      void ConnectEngine.saveLocal("recordings", "file", blob, `meeting-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.webm`);
    };
  }, [session]);
  // "<name> started / stopped recording" - to everyone, by name
  useEffect(() => {
    const now = new Set([...session.peers.values()].filter((p) => p.recording).map((p) => p.userId));
    for (const id of now) if (!recorders.current.has(id)) setToast(t("meeting.recordingStarted", { name: people.get(id)?.fullName ?? "" }));
    for (const id of recorders.current) if (!now.has(id)) setToast(t("meeting.recordingStopped", { name: people.get(id)?.fullName ?? "" }));
    recorders.current = now;
  });
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const me = profile?.id ?? "";
  const nameOf = (id: string) => (id === me ? t("meeting.you") : people.get(id)?.fullName ?? "");
  const tiles = [{ userId: me, stream: session.local, muted: session.muted, videoOff: session.videoOff || session.media === "audio", hand: session.myHand, recording: session.recording, local: true },
    ...[...session.peers.values()].map((p) => ({ userId: p.userId, stream: p.stream, muted: p.muted, videoOff: p.videoOff || session.media === "audio" || !p.stream.getVideoTracks().length, hand: p.hand, recording: p.recording, local: false }))];
  const layout: Layout = session.sharingBy ? "share" : layoutChoice ?? (session.media === "audio" || tiles.length > 2 ? "host" : "grid");
  const center = session.sharingBy ?? session.pinned ?? session.hostId;
  const recordingBy = [...session.peers.values()].find((p) => p.recording)?.userId ?? (session.recording ? me : null);

  const tile = (t0: (typeof tiles)[number], big = false) => (
    <div key={t0.userId} className={`${styles.tile} ${big ? styles.big : ""} ${t0.recording ? styles.recTile : ""}`}>
      {!t0.videoOff && t0.stream ? (
        <video
          className={t0.local && session.sharingBy !== me ? styles.mirror : undefined}
          autoPlay playsInline muted={t0.local}
          ref={(el) => {
            if (!el) return;
            videos.current.set(t0.userId, el);
            if (el.srcObject !== t0.stream) el.srcObject = t0.stream;
          }}
        />
      ) : (
        <>
          <Avatar name={nameOf(t0.userId)} url={people.get(t0.userId)?.avatarUrl ?? null} size={big ? "lg" : "md"} />
          {!t0.local && t0.stream ? <audio autoPlay ref={(el) => { if (el && el.srcObject !== t0.stream) el.srcObject = t0.stream; }} /> : null}
        </>
      )}
      <span className={styles.label}>
        {t0.userId === session.hostId ? <span className={styles.hostTag}>{t("meeting.host")}</span> : null}
        {nameOf(t0.userId)}
      </span>
      {t0.muted ? <span className={styles.muteMark} aria-label={t("meeting.muted")}><MicOff size={12} /></span> : null}
      {t0.hand ? <span className={styles.handMark} aria-label={t("meeting.hand")}><Hand size={14} /></span> : null}
      {t0.recording ? <span className={styles.recDot} aria-label={t("meeting.recording")} /> : null}
      {session.isHost && !t0.local ? (
        <button type="button" className={styles.pinBtn} onClick={() => session.pin(session.pinned === t0.userId ? null : t0.userId)} aria-label={t("meeting.pin")}><Pin size={12} /></button>
      ) : null}
    </div>
  );

  const centerTile = tiles.find((x) => x.userId === center) ?? tiles[0];
  const others = tiles.filter((x) => x !== centerTile);

  return (
    <div className={styles.screen} role="dialog" aria-modal="true" aria-label={t("meeting.label")}>
      <header className={styles.top}>
        <b>{t(session.media === "video" ? "meeting.videoTitle" : "meeting.audioTitle")}</b>
        <span className={styles.count}><Users size={14} aria-hidden="true" /> {tiles.length}/{session.media === "video" ? 4 : 8}</span>
      </header>
      {recordingBy ? <div className={styles.recBar}>{t("meeting.recordingBy", { name: nameOf(recordingBy) })}</div> : null}
      {toast ? <div className={styles.toast} role="status">{toast}</div> : null}
      {session.weak && session.media === "video" && !session.videoOff ? (
        <button type="button" className={styles.weak} onClick={() => session.toggleVideo()}>{t("meeting.weakSuggest")}</button>
      ) : null}

      <main className={`${styles.stage} ${styles[layout]}`}>
        {layout === "grid" ? tiles.map((x) => tile(x)) : (
          <>
            <div className={styles.centerSlot}>{tile(centerTile, true)}</div>
            <div className={styles.around}>{others.map((x) => tile(x))}</div>
          </>
        )}
      </main>

      {chatOpen ? (
        <aside className={styles.chat}>
          <ul>
            {session.chat.map((m, i) => <li key={i} className={m.from === me ? styles.mine : undefined}><b>{nameOf(m.from)}</b> {m.text}</li>)}
          </ul>
          <form onSubmit={(e) => { e.preventDefault(); session.say(text); setText(""); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("meeting.chatPlaceholder")} aria-label={t("meeting.chatPlaceholder")} />
          </form>
        </aside>
      ) : null}

      <footer className={styles.controls}>
        <GlassButton label={session.muted ? t("call.unmute") : t("call.mute")} onClick={() => session.toggleMute()}>{session.muted ? <MicOff size={18} /> : <Mic size={18} />}</GlassButton>
        {session.media === "video" ? <GlassButton label={session.videoOff ? t("call.videoOn") : t("call.videoOff")} onClick={() => session.toggleVideo()}>{session.videoOff ? <VideoOff size={18} /> : <Video size={18} />}</GlassButton> : null}
        {session.media === "video" && session.screenShareFeature && typeof navigator.mediaDevices?.getDisplayMedia === "function" ? (
          <GlassButton label={t("meeting.share")} tone={session.sharingBy === me ? "primary" : "plain"} onClick={() => void session.toggleShare()}><MonitorUp size={18} /></GlassButton>
        ) : null}
        <GlassButton label={t("meeting.hand")} tone={session.myHand ? "primary" : "plain"} onClick={() => session.raiseHand()}><Hand size={18} /></GlassButton>
        <GlassButton label={t("meeting.chat")} tone={chatOpen ? "primary" : "plain"} onClick={() => setChatOpen((v) => !v)}><MessageSquare size={18} /></GlassButton>
        <GlassButton label={t("meeting.layout")} onClick={() => setLayoutChoice(layout === "grid" ? "host" : "grid")}><LayoutGrid size={18} /></GlassButton>
        {session.recordingFeature && session.recordingAllowed ? (
          <GlassButton label={session.recording ? t("meeting.stopRecording") : t("meeting.record")} tone={session.recording ? "danger" : "plain"}
            onClick={() => (session.recording ? session.stopRecording() : session.startRecording([...videos.current.values()]))}><Circle size={18} /></GlassButton>
        ) : null}
        {session.isHost ? <GlassButton label={t("meeting.muteAll")} onClick={() => session.muteAll()}><VolumeX size={18} /></GlassButton> : null}
        {session.isHost && session.recordingFeature && session.recordingAllowed ? (
          <button type="button" className={styles.textBtn} onClick={() => void session.disableRecording()}>{t("meeting.blockRecording")}</button>
        ) : null}
        <GlassButton label={session.isHost ? t("meeting.endForAll") : t("meeting.leave")} tone="danger" onClick={() => void session.leave()}><PhoneOff size={18} /></GlassButton>
      </footer>
    </div>
  );
}
