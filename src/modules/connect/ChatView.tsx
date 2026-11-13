import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Camera, Check, CheckCheck, Clock3, Download, FileText, Image as ImageIcon, Mic, Phone, PhoneMissed, Plus, Radio, Send, Users, Video } from "lucide-react";

import type { ConnectPerson } from "../../core/repositories/ConnectRepository";
import { formatTimeOnly } from "../../core/utils/formatDate";
import Avatar from "../../components/common/Avatar";
import { ConnectEngine } from "./engine/ConnectEngine";
import type { LocalMessage } from "./engine/localStore";
import { VoiceRecorder, compressImage, formatBytes, formatDuration } from "./engine/media";
import { useConnectContext } from "./ConnectProvider";
import GlassButton from "./GlassButton";
import VerifiedCamera from "./VerifiedCamera";
import styles from "./ChatView.module.css";

// PROSM Connect - one conversation (owner 2026-11-13): written on the device first (🕓), sent when it can (✓), arrived
// (✓✓), read (blue ✓✓). Photos are made smaller; any file up to the plan's limit; a voice message is recorded while
// the microphone is held (the permission is asked on the first press); the verified photo comes from the app's camera
// only. A site's conversation has "push to talk": hold, speak, let go - it plays by itself for those who have the app
// open. A manager can ask someone for a photo from the site.
export default function ChatView({ conversationId, title, person, siteId, maxFileMb, canCall, canPhoto, canPushToTalk, onBack, autoVoice = false, autoCamera = false }: {
  conversationId: string;
  title: string;
  person: ConnectPerson | null;
  siteId: string | null;
  maxFileMb: number;
  canCall: boolean;
  canPhoto: boolean;
  canPushToTalk: boolean;
  onBack?: () => void;
  autoVoice?: boolean;
  autoCamera?: boolean;
}) {
  const { t, i18n } = useTranslation("connect");
  const connect = useConnectContext();
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState<"voice" | "ptt" | null>(null);
  const [camera, setCamera] = useState(autoCamera);
  const [error, setError] = useState("");
  const recorder = useRef<VoiceRecorder | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const urls = useRef(new Map<string, string>());
  const [, setUrlTick] = useState(0);

  const load = useCallback(async () => {
    setMessages(await ConnectEngine.messages(conversationId));
  }, [conversationId]);

  useEffect(() => {
    ConnectEngine.openConversation = conversationId;
    void load();
    void ConnectEngine.markRead(conversationId);
    const offMessage = ConnectEngine.on("message", (m) => {
      if ((m as LocalMessage).conversationId === conversationId) void load();
    });
    const offStatus = ConnectEngine.on("status", () => void load());
    return () => {
      offMessage();
      offStatus();
      if (ConnectEngine.openConversation === conversationId) ConnectEngine.openConversation = null;
    };
  }, [conversationId, load]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages.length]);

  // files on the device, shown through local links
  useEffect(() => {
    let changed = false;
    void Promise.all(messages.filter((m) => m.hasBlob && !urls.current.has(m.id)).map(async (m) => {
      const blob = await ConnectEngine.blob(m.id);
      if (blob) {
        urls.current.set(m.id, URL.createObjectURL(blob));
        changed = true;
      }
    })).then(() => {
      if (changed) setUrlTick((n) => n + 1);
    });
  }, [messages]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  // "send a voice message" after a call that could not get through
  useEffect(() => {
    if (autoVoice) setError(t("chat.holdToRecord"));
  }, [autoVoice, t]);

  const kindForSite = siteId ? "site_broadcast" : "message";
  const sendText = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    await ConnectEngine.send(conversationId, kindForSite, { body, otherUserId: person?.id ?? null });
  };

  const sendFile = async (picked: File | null) => {
    if (!picked) return;
    if (picked.size > maxFileMb * 1024 * 1024) {
      setError(t("chat.tooBig", { mb: maxFileMb }));
      return;
    }
    const isImage = picked.type.startsWith("image/");
    const blob = isImage ? await compressImage(picked) : picked;
    await ConnectEngine.send(conversationId, isImage ? "image" : "file", { blob, fileName: picked.name, otherUserId: person?.id ?? null });
  };

  const startRecording = async (mode: "voice" | "ptt") => {
    setError("");
    try {
      recorder.current = new VoiceRecorder();
      await recorder.current.start();
      setRecording(mode);
    } catch {
      setError(t("chat.micDenied"));
    }
  };

  const stopRecording = async () => {
    const mode = recording;
    setRecording(null);
    const result = await recorder.current?.stop();
    recorder.current = null;
    if (!result || !mode) return;
    await ConnectEngine.send(conversationId, mode === "ptt" ? "push_to_talk" : "voice_note", { blob: result.blob, durationMs: result.durationMs, fileName: mode === "ptt" ? "ptt.webm" : "voice.webm", otherUserId: person?.id ?? null });
  };

  const askPhoto = async () => {
    if (!person) return;
    const ok = await ConnectEngine.sendTo(person.id, "photo_request", t("chat.photoRequestBody"));
    if (ok) await ConnectEngine.send(conversationId, "message", { body: t("chat.photoRequestSent"), otherUserId: person.id });
  };

  const tick = (m: LocalMessage) => {
    if (!m.mine) return null;
    if (m.status === "pending") return <Clock3 size={12} aria-label={t("chat.pending")} />;
    if (m.status === "failed") return <span className={styles.failed}>!</span>;
    if (m.status === "sent") return <Check size={12} aria-label={t("chat.sent")} />;
    return <CheckCheck size={13} className={m.status === "read" ? styles.read : undefined} aria-label={t(m.status === "read" ? "chat.read" : "chat.delivered")} />;
  };

  const bubble = (m: LocalMessage) => {
    const url = urls.current.get(m.id);
    let content: React.ReactNode;
    switch (m.kind) {
      case "image":
      case "camera_photo":
        content = (
          <>
            {url ? <img src={url} alt={m.kind === "camera_photo" ? t("chat.verifiedPhoto") : t("chat.photo")} className={styles.photo} /> : <span className={styles.meta}><ImageIcon size={14} /> {t("chat.photo")}</span>}
            {m.kind === "camera_photo" && m.proofCode ? <span className={styles.proof}>✓ {t("chat.verifiedPhoto")} · <span dir="ltr">#{m.proofCode}</span></span> : null}
          </>
        );
        break;
      case "voice_note":
      case "push_to_talk":
        content = (
          <span className={styles.voice}>
            {m.kind === "push_to_talk" ? <Radio size={14} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
            {url ? <audio src={url} controls preload="metadata" /> : null}
            {m.durationMs ? <small>{formatDuration(m.durationMs)}</small> : null}
          </span>
        );
        break;
      case "file":
        content = (
          <a className={styles.file} href={url} download={m.fileName ?? "file"}>
            <FileText size={18} aria-hidden="true" />
            <span>{m.fileName ?? t("chat.file")}<small>{formatBytes(m.sizeBytes)}</small></span>
            <Download size={14} aria-hidden="true" />
          </a>
        );
        break;
      case "missed":
        content = <span className={styles.meta}><PhoneMissed size={14} /> {t("chat.missedCall")}</span>;
        break;
      case "photo_request":
        content = (
          <span className={styles.request}>
            <span>📷 {m.body ?? t("chat.photoRequestBody")}</span>
            {!m.mine && canPhoto ? <button type="button" onClick={() => setCamera(true)}>{t("chat.takeIt")}</button> : null}
          </span>
        );
        break;
      case "meeting_invite":
        content = (
          <span className={styles.request}>
            <span><Users size={14} /> {t("chat.meetingInvite")}</span>
            {!m.mine && m.refId ? <button type="button" onClick={() => void connect?.joinMeeting(m.refId!)}>{t("meeting.join")}</button> : null}
          </span>
        );
        break;
      default:
        content = <span className={styles.text}>{m.body}</span>;
    }
    return (
      <div key={m.id} className={m.mine ? `${styles.bubble} ${styles.out}` : `${styles.bubble} ${styles.in}`}>
        {siteId && !m.mine ? <b className={styles.sender}>{connect?.people.get(m.fromUser)?.fullName ?? ""}</b> : null}
        {content}
        <span className={styles.time}>{formatTimeOnly(m.createdAt, i18n.language)} {tick(m)}</span>
      </div>
    );
  };

  return (
    <section className={styles.chat} aria-label={title}>
      <header className={styles.head}>
        {onBack ? <GlassButton label={t("chat.back")} size="small" onClick={onBack}><ArrowRight size={16} /></GlassButton> : null}
        <span className={styles.who}>
          {person ? <Avatar name={person.fullName} url={person.avatarUrl} size="sm" /> : <span className={styles.siteIcon}><Radio size={16} /></span>}
          <span className={styles.names}>
            <b>{title}</b>
            <small>{person ? (person.presence === "out" ? t("presence.out") : person.currentSiteName ? t("presence.atSite", { site: person.currentSiteName }) : t(`presence.${person.presence}`)) : t("chat.siteSubtitle")}</small>
          </span>
        </span>
        {person && canPhoto ? <GlassButton label={t("chat.askPhoto")} size="small" onClick={() => void askPhoto()}><Camera size={16} /></GlassButton> : null}
        {person && canCall ? (
          <>
            <GlassButton label={t("actions.audioCall")} size="small" onClick={() => void connect?.startCall(person.id, "audio")}><Phone size={16} /></GlassButton>
            <GlassButton label={t("actions.videoCall")} tone="primary" size="small" onClick={() => void connect?.startCall(person.id, "video")}><Video size={16} /></GlassButton>
          </>
        ) : null}
      </header>

      <div className={styles.list} ref={list}>
        {messages.length === 0 ? <p className={styles.empty}>{t("chat.empty")}</p> : messages.map(bubble)}
      </div>

      {error ? <p className={styles.error} role="status">{error}</p> : null}
      {recording ? <div className={styles.recording}>{t(recording === "ptt" ? "chat.talking" : "chat.recording")}</div> : null}

      <footer className={styles.composer}>
        <input ref={file} type="file" hidden onChange={(e) => { void sendFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <GlassButton label={t("chat.attach")} size="small" onClick={() => file.current?.click()}><Plus size={18} /></GlassButton>
        {canPhoto ? <GlassButton label={t("chat.verifiedCamera")} size="small" onClick={() => setCamera(true)}><Camera size={18} /></GlassButton> : null}
        <form className={styles.field} onSubmit={(e) => { e.preventDefault(); void sendText(); }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("chat.placeholder")} aria-label={t("chat.placeholder")} maxLength={4000} />
        </form>
        {text.trim() ? (
          <GlassButton label={t("chat.send")} tone="primary" onClick={() => void sendText()}><Send size={18} /></GlassButton>
        ) : (
          <>
            {siteId && canPushToTalk ? (
              <GlassButton label={t("chat.pushToTalk")} tone={recording === "ptt" ? "danger" : "plain"}
                onPointerDown={() => void startRecording("ptt")} onPointerUp={() => void stopRecording()} onPointerLeave={() => recording && void stopRecording()}>
                <Radio size={18} />
              </GlassButton>
            ) : null}
            <GlassButton label={t("chat.holdToRecord")} tone={recording === "voice" ? "danger" : "primary"}
              onPointerDown={() => void startRecording("voice")} onPointerUp={() => void stopRecording()} onPointerLeave={() => recording && void stopRecording()}>
              <Mic size={18} />
            </GlassButton>
          </>
        )}
      </footer>

      {camera ? (
        <VerifiedCamera
          onClose={() => setCamera(false)}
          onDone={(photo, code) => {
            setCamera(false);
            void ConnectEngine.send(conversationId, "camera_photo", { blob: photo, fileName: `${code}.jpg`, proofCode: code, otherUserId: person?.id ?? null });
          }}
        />
      ) : null}
    </section>
  );
}
