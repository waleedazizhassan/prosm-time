import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Camera, Check, CheckCheck, Clock3, Download, FileText, Image as ImageIcon, Mic, Phone, PhoneMissed, Plus, Radio, Send, Users, Video } from "lucide-react";

import type { ConnectPerson } from "../../core/repositories/ConnectRepository";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import saveGeneratedFile from "../../core/utils/saveGeneratedFile";
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

  const dayLabel = (iso: string) => {
    const date = new Date(iso);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (date.toDateString() === today.toDateString()) return t("chat.today");
    if (date.toDateString() === yesterday.toDateString()) return t("chat.yesterday");
    return formatDateOnly(iso, i18n.language);
  };

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

  // owner 2026-11-14: save a photo or document that came in (Android: the share sheet - save to Files / Drive / Gallery)
  const download = async (m: LocalMessage) => {
    const blob = await ConnectEngine.blob(m.id);
    if (!blob) return;
    const ext = (blob.type.split("/")[1] ?? "bin").replace("jpeg", "jpg").split(";")[0];
    const name = m.fileName ?? `PROSM-${m.kind === "camera_photo" ? "verified" : "photo"}-${m.createdAt.slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
    await saveGeneratedFile(name, blob).catch(() => undefined);
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
            {url ? (
              <span className={styles.photoWrap}>
                <img src={url} alt={m.kind === "camera_photo" ? t("chat.verifiedPhoto") : t("chat.photo")} className={styles.photo} />
                <button type="button" className={styles.save} aria-label={t("chat.download")} onClick={() => void download(m)}><Download size={16} /></button>
              </span>
            ) : <span className={styles.meta}><ImageIcon size={14} /> {t("chat.photo")}</span>}
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
          <button type="button" className={styles.file} disabled={!url} onClick={() => void download(m)} aria-label={`${t("chat.download")} ${m.fileName ?? t("chat.file")}`}>
            <FileText size={18} aria-hidden="true" />
            <span>{m.fileName ?? t("chat.file")}<small>{formatBytes(m.sizeBytes)}</small></span>
            <Download size={16} aria-hidden="true" />
          </button>
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
          {person ? <span className={styles.headAvatar}><Avatar name={person.fullName} url={person.avatarUrl} size="sm" /><i className={`${styles.dot} ${styles[`dot_${person.presence}`]}`} aria-hidden="true" /></span> : <span className={styles.siteIcon}><Radio size={16} /></span>}
          <span className={styles.names}>
            <b>{title}</b>
            <small className={person ? styles[`sub_${person.presence}`] : undefined}>{person ? (person.presence === "out" ? t("presence.out") : person.currentSiteName ? t("presence.atSite", { site: person.currentSiteName }) : t(`presence.${person.presence}`)) : t("chat.siteSubtitle")}</small>
          </span>
        </span>
        {person && canCall ? (
          <>
            <GlassButton label={t("actions.audioCall")} size="small" onClick={() => void connect?.startCall(person.id, "audio")}><Phone size={16} /></GlassButton>
            <GlassButton label={t("actions.videoCall")} tone="primary" size="small" onClick={() => void connect?.startCall(person.id, "video")}><Video size={16} /></GlassButton>
          </>
        ) : null}
      </header>

      <div className={styles.list} ref={list}>
        {messages.length === 0 ? <p className={styles.empty}>{t("chat.empty")}</p> : messages.map((m, i) => {
          // owner 2026-11-14: the day between messages ("Today", "Yesterday", then the date)
          const day = m.createdAt.slice(0, 10);
          const showDay = i === 0 || messages[i - 1].createdAt.slice(0, 10) !== day;
          return (
            <Fragment key={m.id}>
              {showDay ? <span className={styles.day}>{dayLabel(m.createdAt)}</span> : null}
              {bubble(m)}
            </Fragment>
          );
        })}
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
