import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { HardDrive, MessageCircle, Phone, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Radio, Search, Users, Video, Volume2 } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import type { ConnectPerson } from "../../core/repositories/ConnectRepository";
import { formatDateTime, formatTimeOnly } from "../../core/utils/formatDate";
import Avatar from "../../components/common/Avatar";
import EmptyState from "../../components/common/EmptyState";
import { ConnectEngine } from "./engine/ConnectEngine";
import type { LocalConversation } from "./engine/localStore";
import { useConnectContext } from "./ConnectProvider";
import ChatView from "./ChatView";
import SoundSettings from "./SoundSettings";
import StoragePanel from "./StoragePanel";
import GlassButton from "./GlassButton";
import useConnect from "./useConnect";
import styles from "./ConnectPage.module.css";

type Tab = "chats" | "calls" | "meetings";
type Filter = "all" | "sites" | "teams" | "unread";
interface CallRow { id: string; media: "audio" | "video"; status: string; outgoing: boolean; otherId: string; createdAt: string; answeredAt: string | null; endedAt: string | null }

// PROSM Connect (owner 2026-11-13): the module's home - the conversations (everyone with their internal number and
// their attendance status: where they are before you talk to them), a site's people in one message, the call log,
// the meetings, and the device's storage. On a computer: three columns - the list, the conversation, the person.
export default function ConnectPage() {
  const { t, i18n } = useTranslation("connect");
  const { profile } = useAuth();
  const { on, features, extensionOf } = useConnect(profile?.id);
  const connect = useConnectContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: Tab = location.pathname.endsWith("/calls") ? "calls" : location.pathname.endsWith("/meetings") ? "meetings" : "chats";
  const [conversations, setConversations] = useState<LocalConversation[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sites, setSites] = useState<Site[]>([]);
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [storage, setStorage] = useState(false);
  const [sounds, setSounds] = useState(false);
  const [error, setError] = useState("");
  const [meetingMedia, setMeetingMedia] = useState<"video" | "audio">("video");
  const [invitees, setInvitees] = useState<string[]>([]);
  const [meetingTitle, setMeetingTitle] = useState("");
  const people = connect?.people ?? new Map<string, ConnectPerson>();
  // owner 2026-11-14: the owner sees everyone; nobody else sees the owner in the lists (a conversation the owner
  // started still shows, so it can be answered)
  const listable = (p: ConnectPerson) => p.id !== profile?.id && p.isActive && (!p.isOwner || Boolean(profile?.isOwner));
  const selected = params.get("c");

  const reload = useCallback(async () => setConversations(await ConnectEngine.conversations()), []);
  useEffect(() => {
    if (!on) return undefined;
    void reload();
    void SiteRepository.listSites().then((r) => setSites(r.success ? r.data ?? [] : []));
    return ConnectEngine.on("conversations", () => void reload());
  }, [on, reload]);

  useEffect(() => {
    if (!on || tab !== "calls") return;
    void ConnectEngine.supabase.rpc("list_prosm_time_connect_calls").then(({ data }) => setCalls((data as CallRow[]) ?? []));
  }, [on, tab, connect?.call]);

  // "message" from the people list, a person's page or a call lands here with ?to=<person>
  const wanted = params.get("to");
  useEffect(() => {
    if (!wanted || !on) return;
    void ConnectEngine.directWith(wanted).then((id) => {
      if (id) setParams({ c: id }, { replace: true });
      else setError(t("openFailed"));
    });
  }, [wanted, on, setParams, t]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const withConversation = new Set(conversations.map((c) => c.otherUserId).filter(Boolean) as string[]);
    const convRows = conversations
      .filter((c) => c.id !== "recordings" || filter === "all")
      .map((c) => ({ kind: "conversation" as const, c, person: c.otherUserId ? people.get(c.otherUserId) ?? null : null }));
    const peopleRows = [...people.values()]
      .filter((p) => listable(p) && !withConversation.has(p.id))
      .map((p) => ({ kind: "person" as const, p }));
    const all = [...convRows, ...peopleRows];
    return all.filter((row) => {
      const name = row.kind === "conversation" ? titleOf(row.c, row.person) : row.p.fullName;
      const person = row.kind === "conversation" ? row.person : row.p;
      if (q && !name.toLowerCase().includes(q) && !(person && (extensionOf(person.id) ?? "").includes(q)) && !(person?.currentSiteName ?? "").toLowerCase().includes(q)) return false;
      if (filter === "unread") return row.kind === "conversation" && row.c.unread > 0;
      // owner 2026-11-14: "at sites" = at work now (in or on a break) - someone on leave is not at a site
      const atWork = (x: { presence: string } | null | undefined) => Boolean(x && (x.presence === "in" || x.presence === "break"));
      if (filter === "sites") return row.kind === "conversation" ? row.c.kind === "site" || atWork(person) : atWork(row.p);
      if (filter === "teams") return row.kind === "conversation" && row.c.kind !== "direct";
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, people, query, filter, profile?.id, extensionOf]);

  if (!profile) return null;
  if (features && !on) return <Navigate to="/dashboard" replace />;

  function titleOf(c: LocalConversation, person: ConnectPerson | null) {
    if (c.id === "recordings") return t("recordings");
    if (c.kind === "site") return sites.find((s) => `site:${s.id}` === c.id)?.name ?? t("siteConversation");
    return person?.fullName ?? c.title ?? "";
  }

  const where = (p: ConnectPerson) =>
    p.presence === "out" ? t("presence.out") : p.currentSiteName ? t("presence.atSite", { site: p.currentSiteName }) : t(`presence.${p.presence}`);
  const presentAt = (site: Site) => [...people.values()].filter((p) => p.presence !== "out" && p.currentSiteName === site.name).length;

  const openPerson = async (p: ConnectPerson) => {
    const id = await ConnectEngine.directWith(p.id);
    if (id) setParams({ c: id });
    else setError(t("openFailed"));
  };

  const current = selected ? conversations.find((c) => c.id === selected) ?? null : null;
  const currentSite = selected?.startsWith("site:") ? sites.find((s) => `site:${s.id}` === selected) ?? null : null;
  const currentPerson = current?.otherUserId ? people.get(current.otherUserId) ?? null : null;
  const chatTitle = current ? titleOf(current, currentPerson) : currentSite?.name ?? "";

  const startMeeting = async () => {
    if (invitees.length === 0) return;
    await connect?.startMeeting(meetingMedia, invitees, meetingTitle.trim() || null);
    setInvitees([]);
    setMeetingTitle("");
  };

  const chat = selected ? (
    <ChatView
      key={selected}
      conversationId={selected}
      title={chatTitle}
      person={currentPerson}
      siteId={currentSite?.id ?? (selected.startsWith("site:") ? selected.slice(5) : null)}
      maxFileMb={features?.maxFileMb ?? 100}
      canCall={Boolean(features?.calls)}
      canPhoto={Boolean(features?.cameraPhoto)}
      canPushToTalk={Boolean(features?.pushToTalk)}
      onBack={() => setParams({})}
      autoVoice={params.get("voice") === "1"}
      autoCamera={params.get("camera") === "1"}
    />
  ) : null;

  const list = (
    <div className={styles.side}>
      {/* owner 2026-11-14: a short header like a messaging app - no numbers (they had no use for the person) */}
      <header className={styles.bar}>
        <h1 className={styles.title}>{t(`tabs.${tab}`)}</h1>
        <span className={styles.barActions}>
          {features?.meetings ? <GlassButton label={t("meeting.newTitle")} size="small" onClick={() => navigate("/connect/meetings")}><Users size={16} /></GlassButton> : null}
          <GlassButton label={t("sound.title")} size="small" onClick={() => setSounds(true)}><Volume2 size={16} /></GlassButton>
          <GlassButton label={t("storage.title")} size="small" onClick={() => setStorage(true)}><HardDrive size={16} /></GlassButton>
        </span>
      </header>

      <nav className={styles.tabs} aria-label={t("tabsLabel")}>
        {(["chats", "calls", "meetings"] as Tab[]).map((key) => (
          <button key={key} type="button" className={tab === key ? `${styles.tab} ${styles.tabOn}` : styles.tab} aria-current={tab === key ? "page" : undefined}
            onClick={() => navigate(key === "chats" ? "/connect" : `/connect/${key}`)}>
            {key === "chats" ? <MessageCircle size={16} aria-hidden="true" /> : key === "calls" ? <PhoneCall size={16} aria-hidden="true" /> : <Users size={16} aria-hidden="true" />}
            {t(`tabs.${key}`)}
          </button>
        ))}
      </nav>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {connect?.error ? <p className={styles.error} role="alert" data-error={connect.error} onClick={connect.clearError}>{t("actionFailed")}</p> : null}

      {tab === "chats" ? (
        <>
          <label className={styles.search}>
            <Search size={16} aria-hidden="true" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} aria-label={t("searchPlaceholder")} />
          </label>
          <div className={styles.chips} role="group" aria-label={t("filtersLabel")}>
            {(["all", "sites", "teams", "unread"] as Filter[]).map((key) => (
              <button key={key} type="button" className={filter === key ? `${styles.chip} ${styles.chipOn}` : styles.chip} onClick={() => setFilter(key)} aria-pressed={filter === key}>{t(`filters.${key}`)}</button>
            ))}
          </div>
          {filter === "sites" && features?.siteBroadcast ? (
            <ul className={styles.list}>
              {sites.map((site) => (
                <li key={site.id}>
                  <button type="button" className={styles.row} onClick={() => setParams({ c: `site:${site.id}` })}>
                    <span className={styles.siteAvatar}><Radio size={16} /></span>
                    <span className={styles.main}><span className={styles.name}>{site.name}</span><span className={styles.where}>{t("presentNow", { count: presentAt(site) })}</span></span>
                    <span className={styles.broadcast}>{t("messageToPresent", { count: presentAt(site) })}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {rows.length === 0 ? <EmptyState message={t(filter === "unread" ? "noUnread" : "noPeople")} /> : (
            <ul className={styles.list}>
              {rows.map((row) => {
                if (row.kind === "conversation") {
                  const p = row.person;
                  return (
                    <li key={row.c.id} className={styles.personRow}>
                      <button type="button" className={selected === row.c.id ? `${styles.row} ${styles.rowOn}` : styles.row} onClick={() => setParams({ c: row.c.id })}>
                        <span className={styles.avatar}>
                          {p ? <Avatar name={p.fullName} url={p.avatarUrl} size="md" /> : <span className={styles.siteAvatar}><Radio size={16} /></span>}
                          {p ? <i className={`${styles.dot} ${styles[`dot_${p.presence}`]}`} aria-hidden="true" /> : null}
                        </span>
                        <span className={styles.main}>
                          <span className={styles.name}>{titleOf(row.c, p)}</span>
                          <span className={styles.last}>{row.c.lastPreview}</span>
                          {p ? <span className={`${styles.where} ${styles[`where_${p.presence}`]}`}>{where(p)}</span> : null}
                        </span>
                        <span className={styles.end}>
                          <small>{row.c.lastAt > "1971" ? formatTimeOnly(row.c.lastAt, i18n.language) : ""}</small>
                          {row.c.unread > 0 ? <b className={styles.badge}>{row.c.unread}</b> : null}
                        </span>
                      </button>
                      {/* owner 2026-11-14: the same buttons on every row - a person one already talked to keeps them */}
                      {p ? (
                        <span className={styles.actions}>
                          <GlassButton label={t("actions.message", { name: p.fullName })} tone="primary" size="small" onClick={() => setParams({ c: row.c.id })}><MessageCircle size={16} /></GlassButton>
                          {features?.calls ? <GlassButton label={t("actions.audioCall")} size="small" onClick={() => void connect?.startCall(p.id, "audio")}><Phone size={16} /></GlassButton> : null}
                          {features?.calls ? <GlassButton label={t("actions.videoCall")} size="small" onClick={() => void connect?.startCall(p.id, "video")}><Video size={16} /></GlassButton> : null}
                        </span>
                      ) : null}
                    </li>
                  );
                }
                const p = row.p;
                return (
                  <li key={p.id} className={styles.personRow}>
                    <button type="button" className={styles.row} onClick={() => void openPerson(p)}>
                      <span className={styles.avatar}><Avatar name={p.fullName} url={p.avatarUrl} size="md" /><i className={`${styles.dot} ${styles[`dot_${p.presence}`]}`} aria-hidden="true" /></span>
                      <span className={styles.main}>
                        <span className={styles.name}>{p.fullName}</span>
                        <span className={`${styles.where} ${styles[`where_${p.presence}`]}`}>{where(p)}</span>
                      </span>
                    </button>
                    <span className={styles.actions}>
                      <GlassButton label={t("actions.message", { name: p.fullName })} tone="primary" size="small" onClick={() => void openPerson(p)}><MessageCircle size={16} /></GlassButton>
                      {features?.calls ? <GlassButton label={t("actions.audioCall")} size="small" onClick={() => void connect?.startCall(p.id, "audio")}><Phone size={16} /></GlassButton> : null}
                      {features?.calls ? <GlassButton label={t("actions.videoCall")} size="small" onClick={() => void connect?.startCall(p.id, "video")}><Video size={16} /></GlassButton> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : tab === "calls" ? (
        !features?.calls ? <EmptyState message={t("callsNotInPlan")} /> : calls === null ? null : calls.length === 0 ? <EmptyState message={t("noCalls")} /> : (
          <ul className={styles.list}>
            {calls.map((c) => {
              const p = people.get(c.otherId);
              const missed = ["missed", "rejected", "busy", "failed"].includes(c.status);
              return (
                <li key={c.id} className={styles.personRow}>
                  <span className={styles.row}>
                    <span className={styles.avatar}><Avatar name={p?.fullName ?? ""} url={p?.avatarUrl ?? null} size="md" /></span>
                    <span className={styles.main}>
                      <span className={styles.name}>{p?.fullName ?? ""}</span>
                      <span className={missed ? `${styles.last} ${styles.missed}` : styles.last}>
                        {missed ? <PhoneMissed size={13} /> : c.outgoing ? <PhoneOutgoing size={13} /> : <PhoneIncoming size={13} />}
                        {" "}{t(`callStatus.${c.status}`)} · {c.media === "video" ? t("video") : t("audio")} · {formatDateTime(c.createdAt, i18n.language)}
                      </span>
                    </span>
                  </span>
                  <span className={styles.actions}>
                    <GlassButton label={t("actions.audioCall")} size="small" onClick={() => void connect?.startCall(c.otherId, "audio")}><Phone size={16} /></GlassButton>
                    <GlassButton label={t("actions.videoCall")} tone="primary" size="small" onClick={() => void connect?.startCall(c.otherId, "video")}><Video size={16} /></GlassButton>
                  </span>
                </li>
              );
            })}
          </ul>
        )
      ) : !features?.meetings ? <EmptyState message={t("meetingsNotInPlan")} /> : (
        <section className={styles.meetingForm}>
          <h2>{t("meeting.newTitle")}</h2>
          <div className={styles.mediaToggle} role="radiogroup" aria-label={t("meeting.mediaLabel")}>
            {(["video", "audio"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={meetingMedia === m} className={meetingMedia === m ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                onClick={() => { setMeetingMedia(m); setInvitees((list) => list.slice(0, m === "video" ? 3 : 7)); }}>
                {m === "video" ? <Video size={14} /> : <Phone size={14} />} {t(m === "video" ? "meeting.videoUpTo" : "meeting.audioUpTo")}
              </button>
            ))}
          </div>
          <input className={styles.titleInput} value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} placeholder={t("meeting.titlePlaceholder")} maxLength={120} />
          <p className={styles.hint}>{t("meeting.pick", { count: (meetingMedia === "video" ? 3 : 7) - invitees.length })}</p>
          {/* owner 2026-11-14: no long list to scroll - each person a small chip, tapped to invite */}
          <div className={styles.pickGrid} role="group" aria-label={t("meeting.pick", { count: (meetingMedia === "video" ? 3 : 7) - invitees.length })}>
            {[...people.values()].filter(listable).map((p) => {
              const checked = invitees.includes(p.id);
              const full = !checked && invitees.length >= (meetingMedia === "video" ? 3 : 7);
              return (
                <button key={p.id} type="button" aria-pressed={checked} disabled={full}
                  className={checked ? `${styles.pick} ${styles.pickOn}` : styles.pick}
                  onClick={() => setInvitees((list) => (checked ? list.filter((x) => x !== p.id) : [...list, p.id]))}>
                  <span className={styles.pickAvatar}>
                    <Avatar name={p.fullName} url={p.avatarUrl} size="sm" />
                    <i className={`${styles.dot} ${styles[`dot_${p.presence}`]}`} aria-hidden="true" />
                  </span>
                  <span className={styles.pickName}>{p.fullName}</span>
                </button>
              );
            })}
          </div>
          <button type="button" className={styles.startBtn} disabled={invitees.length === 0} onClick={() => void startMeeting()}>
            {meetingMedia === "video" ? <Video size={18} /> : <Phone size={18} />} {t("meeting.start")}
          </button>
        </section>
      )}
    </div>
  );

  return (
    <div className={selected ? `${styles.page} ${styles.hasChat}` : styles.page}>
      {list}
      <div className={styles.chatCol}>{chat ?? <div className={styles.placeholder}><MessageCircle size={40} aria-hidden="true" /><p>{t("pickConversation")}</p></div>}</div>
      {currentPerson ? (
        <aside className={styles.info}>
          <Avatar name={currentPerson.fullName} url={currentPerson.avatarUrl} size="lg" />
          <h3>{currentPerson.fullName}</h3>
          <dl>
            <dt>{t("info.today")}</dt>
            <dd>{currentPerson.presence === "out" ? t("presence.out") : currentPerson.clockInAt ? t("info.inSince", { time: formatTimeOnly(currentPerson.clockInAt, i18n.language) }) : t(`presence.${currentPerson.presence}`)}</dd>
            <dt>{t("info.site")}</dt>
            <dd>{currentPerson.currentSiteName ?? currentPerson.siteNames.join("، ") ?? "—"}</dd>
            <dt>{t("info.role")}</dt>
            <dd>{t(`common:roles.${currentPerson.roleKey}`, { defaultValue: currentPerson.roleName })}</dd>
          </dl>
        </aside>
      ) : null}
      {storage ? <StoragePanel onClose={() => setStorage(false)} /> : null}
      {sounds ? <SoundSettings onClose={() => setSounds(false)} /> : null}
    </div>
  );
}
