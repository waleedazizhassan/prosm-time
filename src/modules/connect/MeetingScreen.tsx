import { useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Circle, Hand, LayoutGrid, Maximize2, SmilePlus, MessageSquare, Mic, MicOff, Minimize2, MonitorUp, PhoneOff, Pin, Users, Video, VideoOff, VolumeX, Send } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import type { ConnectPerson } from "../../core/repositories/ConnectRepository";
import Avatar from "../../components/common/Avatar";
import { REACTIONS, type MeetingSession } from "./engine/MeetingSession";
import { ConnectEngine } from "./engine/ConnectEngine";
import GlassButton from "./GlassButton";
import styles from "./MeetingScreen.module.css";
import { playMedia } from "./engine/media";
import { messageAlert } from "./engine/sounds";

// owner 2026-11-16: ready reactions in the meeting chat, one tap sends
const QUICK: readonly string[] = REACTIONS;
// a transparent poster: the phone's web view drew a big "play" sign on a video until it starts
const NO_POSTER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
export const MEETING_LIMIT = { video: 6, audio: 12 } as const;

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
  // owner 2026-11-16: "a reaction that shows on the screen - someone says something, another answers 'fine' without
  // sound" - the reactions bar, apart from the chat
  const [reactOpen, setReactOpen] = useState(false);
  const [text, setText] = useState("");
  const [layoutChoice, setLayoutChoice] = useState<Layout | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // phase G: the browser refused to start someone's sound by itself - one tap starts everyone's
  const [soundBlocked, setSoundBlocked] = useState(false);
  const startSound = (el: HTMLMediaElement | null) => void playMedia(el).then((ok) => { if (!ok) setSoundBlocked(true); });
  const enableAllSound = () => {
    setSoundBlocked(false);
    document.querySelectorAll<HTMLMediaElement>("[data-connect-remote]").forEach((el) => startSound(el));
  };
  const videos = useRef(new Map<string, HTMLVideoElement>());
  // owner 2026-11-16: full screen for a shared screen or the person in the middle
  const [full, setFull] = useState<string | null>(null);
  const tileEls = useRef(new Map<string, HTMLDivElement>());
  const openFull = (userId: string) => {
    setFull(userId);
    const el = tileEls.current.get(userId);
    void el?.requestFullscreen?.().catch(() => undefined);
  };
  const closeFull = () => {
    setFull(null);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFull(null); };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  // owner 2026-11-16: a message in the meeting chat was silent - a count on the chat button, the message on top, a sound
  const [seen, setSeen] = useState(0);
  const lastCount = useRef(session.chat.length);
  useEffect(() => {
    if (session.chat.length > lastCount.current) {
      const last = session.chat[session.chat.length - 1];
      if (last && last.from !== (profile?.id ?? "") && !chatOpen) {
        setToast(`${people.get(last.from)?.fullName ?? ""}: ${last.text}`);
        messageAlert();
      }
    }
    lastCount.current = session.chat.length;
    if (chatOpen) setSeen(session.chat.length);
  });
  const unread = chatOpen ? 0 : session.chat.slice(seen).filter((m) => m.from !== (profile?.id ?? "")).length;
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
    <div key={t0.userId} className={`${styles.tile} ${big ? styles.big : ""} ${t0.recording ? styles.recTile : ""} ${full === t0.userId ? styles.full : ""}`}
      ref={(el) => { if (el) tileEls.current.set(t0.userId, el); }}
      onDoubleClick={() => (full === t0.userId ? closeFull() : openFull(t0.userId))}>
      {!t0.videoOff && t0.stream ? (
        // owner 2026-11-16 (a person's picture missing on the phone): the phone's web view will not start a video
        // with sound by itself, so the picture is always silent and the sound plays on its own element below
        <video
          className={t0.local && session.sharingBy !== me ? styles.mirror : undefined}
          autoPlay playsInline muted poster={NO_POSTER}
          ref={(el) => {
            if (!el) return;
            videos.current.set(t0.userId, el);
            el.muted = true;
            if (el.srcObject !== t0.stream) el.srcObject = t0.stream;
            void playMedia(el);
          }}
          onLoadedMetadata={(e) => void playMedia(e.currentTarget)}
        />
      ) : (
        <Avatar name={nameOf(t0.userId)} url={people.get(t0.userId)?.avatarUrl ?? null} size={big ? "lg" : "md"} />
      )}
      {!t0.local && t0.stream ? <audio autoPlay data-connect-remote="" ref={(el) => { if (el && el.srcObject !== t0.stream) el.srcObject = t0.stream; if (el) startSound(el); }} /> : null}
      {!t0.videoOff && t0.stream ? (
        <button type="button" className={styles.fullBtn} onClick={(e) => { e.stopPropagation(); if (full === t0.userId) closeFull(); else openFull(t0.userId); }}
          aria-label={full === t0.userId ? t("meeting.exitFull") : t("meeting.full")} title={full === t0.userId ? t("meeting.exitFull") : t("meeting.full")}>
          {full === t0.userId ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      ) : null}
      {session.reactions.filter((r) => r.from === t0.userId).slice(-3).map((r, i) => (
        <span key={r.id} className={styles.floatReact} style={{ insetInlineStart: `${18 + i * 22}%` }} aria-live="polite">{r.emoji}</span>
      ))}
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
    <div className={`${styles.screen} ${chatOpen ? styles.withChat : ""}`} role="dialog" aria-modal="true" aria-label={t("meeting.label")}>
      {soundBlocked ? (
        <button type="button" className={styles.enableSound} onClick={enableAllSound}>{t("call.enableSound")}</button>
      ) : null}
      <header className={styles.top}>
        <b>{t(session.media === "video" ? "meeting.videoTitle" : "meeting.audioTitle")}</b>
        <span className={styles.count}><Users size={14} aria-hidden="true" /> {tiles.length}/{session.media === "video" ? MEETING_LIMIT.video : MEETING_LIMIT.audio}</span>
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
            {session.chat.map((m, i) => (
              <li key={i} className={m.from === me ? styles.mine : undefined}>
                <b>{nameOf(m.from)}</b> <span className={QUICK.includes(m.text) ? styles.bigEmoji : undefined}>{m.text}</span>
              </li>
            ))}
          </ul>
          <div className={styles.quick} role="group" aria-label={t("meeting.reactions")}>
            {QUICK.map((emoji) => <button key={emoji} type="button" onClick={() => session.say(emoji)} aria-label={emoji}>{emoji}</button>)}
          </div>
          {/* owner 2026-11-15: a send button (there was none - Enter only) */}
          <form className={styles.chatForm} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { session.say(text.trim()); setText(""); } }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("meeting.chatPlaceholder")} aria-label={t("meeting.chatPlaceholder")} enterKeyHint="send" />
            <button type="submit" className={styles.chatSend} disabled={!text.trim()} aria-label={t("meeting.send")}><Send size={18} /></button>
          </form>
        </aside>
      ) : null}

      {reactOpen ? (
        <div className={styles.reactBar} role="group" aria-label={t("meeting.reactions")}>
          {REACTIONS.map((emoji) => (
            <button key={emoji} type="button" aria-label={emoji} onClick={() => { session.react(emoji); setReactOpen(false); }}>{emoji}</button>
          ))}
        </div>
      ) : null}

      <footer className={styles.controls}>
        <GlassButton label={session.muted ? t("call.unmute") : t("call.mute")} onClick={() => session.toggleMute()}>{session.muted ? <MicOff size={18} /> : <Mic size={18} />}</GlassButton>
        {session.media === "video" ? <GlassButton label={session.videoOff ? t("call.videoOn") : t("call.videoOff")} onClick={() => session.toggleVideo()}>{session.videoOff ? <VideoOff size={18} /> : <Video size={18} />}</GlassButton> : null}
        {session.media === "video" && session.screenShareFeature && typeof navigator.mediaDevices?.getDisplayMedia === "function" ? (
          <GlassButton label={t("meeting.share")} tone={session.sharingBy === me ? "primary" : "plain"} onClick={() => void session.toggleShare()}><MonitorUp size={18} /></GlassButton>
        ) : null}
        <GlassButton label={t("meeting.hand")} tone={session.myHand ? "primary" : "plain"} onClick={() => session.raiseHand()}><Hand size={18} /></GlassButton>
        <GlassButton label={t("meeting.react")} tone={reactOpen ? "primary" : "plain"} onClick={() => setReactOpen((v) => !v)}><SmilePlus size={18} /></GlassButton>
        <GlassButton label={unread ? t("meeting.chatUnread", { count: unread }) : t("meeting.chat")} tone={chatOpen ? "primary" : "plain"} className={styles.chatButton} onClick={() => setChatOpen((v) => !v)}>
          <MessageSquare size={18} />
          {unread ? <span className={styles.badge} aria-hidden="true">{unread > 9 ? "9+" : unread}</span> : null}
        </GlassButton>
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
