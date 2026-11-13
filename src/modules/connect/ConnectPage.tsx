import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { MessageCircle, Phone, PhoneCall, Radio, Search, Users, Video } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import PeopleDirectoryRepository, { type DirectoryPerson } from "../../core/repositories/PeopleDirectoryRepository";
import ConnectRepository from "../../core/repositories/ConnectRepository";
import Avatar from "../../components/common/Avatar";
import EmptyState from "../../components/common/EmptyState";
import LoadingState from "../../components/common/LoadingState";
import GlassButton from "./GlassButton";
import useConnect from "./useConnect";
import styles from "./ConnectPage.module.css";

type Tab = "chats" | "calls" | "meetings";
type Filter = "all" | "sites" | "teams" | "unread";

// PROSM Connect (owner 2026-11-13, stage 1): the module's home. The switchboard is 001, everyone has an internal
// number, and each person's status comes from attendance - so you know where someone is before you talk to them.
// The chat itself, calls and meetings arrive in the next stages; until then this page is only in preview builds.
export default function ConnectPage() {
  const { t } = useTranslation("connect");
  const { profile } = useAuth();
  const { on, features, extensionOf } = useConnect(profile?.id);
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tab: Tab = location.pathname.endsWith("/calls") ? "calls" : location.pathname.endsWith("/meetings") ? "meetings" : "chats";
  const [people, setPeople] = useState<DirectoryPerson[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [opening, setOpening] = useState<string | null>(null);
  const [opened, setOpened] = useState<DirectoryPerson | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!on) return;
    void PeopleDirectoryRepository.list().then(setPeople);
  }, [on]);

  // "message" from the people list or a person's page lands here with ?to=<person>
  const wanted = params.get("to");
  useEffect(() => {
    if (!wanted || !people) return;
    const person = people.find((p) => p.id === wanted);
    if (person) void open(person);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, people]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (people ?? [])
      .filter((p) => p.id !== profile?.id && p.isActive)
      .filter((p) => filter !== "sites" || p.presence !== "out")
      .filter((p) => !q || p.fullName.toLowerCase().includes(q) || (extensionOf(p.id) ?? "").includes(q) || (p.currentSiteName ?? "").toLowerCase().includes(q))
      .sort((a, b) => Number(b.presence !== "out") - Number(a.presence !== "out") || a.fullName.localeCompare(b.fullName));
  }, [people, query, filter, profile?.id, extensionOf]);

  if (!profile) return null;
  if (features && !on) return <Navigate to="/dashboard" replace />;

  async function open(person: DirectoryPerson) {
    setOpening(person.id);
    setError("");
    const result = await ConnectRepository.openDirect(person.id);
    setOpening(null);
    if (result.error) {
      setError(t("openFailed"));
      return;
    }
    setOpened(person);
  }

  const where = (p: DirectoryPerson) =>
    p.presence === "out" ? t("presence.out") : p.currentSiteName ? t("presence.atSite", { site: p.currentSiteName }) : t(`presence.${p.presence}`);

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroText}>
          <span className={styles.eyebrow}><Radio size={14} aria-hidden="true" /> PROSM Connect</span>
          <h1 className={styles.title}>{t("title")}</h1>
          <p className={styles.lead}>{t("lead")}</p>
        </div>
        <div className={styles.numbers}>
          <div className={styles.number}>
            <span>{t("myNumber")}</span>
            <strong dir="ltr">{features?.myExtension ?? "—"}</strong>
          </div>
          <div className={styles.number}>
            <span>{t("switchboard")}</span>
            <strong dir="ltr">001</strong>
          </div>
        </div>
      </section>

      <nav className={styles.tabs} aria-label={t("tabsLabel")}>
        {(["chats", "calls", "meetings"] as Tab[]).map((key) => (
          <button key={key} type="button" className={tab === key ? `${styles.tab} ${styles.tabOn}` : styles.tab} aria-current={tab === key ? "page" : undefined}
            onClick={() => navigate(key === "chats" ? "/connect" : `/connect/${key}`)}>
            {key === "chats" ? <MessageCircle size={16} aria-hidden="true" /> : key === "calls" ? <PhoneCall size={16} aria-hidden="true" /> : <Users size={16} aria-hidden="true" />}
            {t(`tabs.${key}`)}
          </button>
        ))}
      </nav>

      {tab === "chats" ? (
        <>
          <div className={styles.searchRow}>
            <label className={styles.search}>
              <Search size={16} aria-hidden="true" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} aria-label={t("searchPlaceholder")} />
            </label>
          </div>
          <div className={styles.chips} role="group" aria-label={t("filtersLabel")}>
            {(["all", "sites", "teams", "unread"] as Filter[]).map((key) => (
              <button key={key} type="button" className={filter === key ? `${styles.chip} ${styles.chipOn}` : styles.chip} onClick={() => setFilter(key)} aria-pressed={filter === key}>
                {t(`filters.${key}`)}
              </button>
            ))}
          </div>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {opened ? (
            <div className={styles.notice} role="status">
              <MessageCircle size={18} aria-hidden="true" />
              <span>{t("conversationReady", { name: opened.fullName })}</span>
            </div>
          ) : null}
          {people === null ? <LoadingState size="sm" /> : list.length === 0 ? <EmptyState message={t(filter === "unread" ? "noUnread" : "noPeople")} /> : (
            <ul className={styles.list}>
              {list.map((p) => (
                <li key={p.id} className={styles.row}>
                  <span className={styles.avatar}>
                    <Avatar name={p.fullName} url={p.avatarUrl} size="md" />
                    {p.presence !== "out" ? <i className={styles.online} aria-hidden="true" /> : null}
                  </span>
                  <span className={styles.main}>
                    <span className={styles.name}>
                      {p.fullName}
                      {extensionOf(p.id) ? <small dir="ltr">{extensionOf(p.id)}</small> : null}
                    </span>
                    <span className={p.presence === "out" ? `${styles.where} ${styles.whereOut}` : styles.where}>{where(p)}</span>
                  </span>
                  <span className={styles.actions}>
                    <GlassButton label={t("actions.message", { name: p.fullName })} tone="primary" size="small" disabled={opening === p.id} onClick={() => void open(p)}>
                      <MessageCircle size={16} />
                    </GlassButton>
                    {features?.calls ? (
                      <>
                        <GlassButton label={t("actions.callSoon")} size="small" disabled><Phone size={16} /></GlassButton>
                        <GlassButton label={t("actions.callSoon")} size="small" disabled><Video size={16} /></GlassButton>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <EmptyState message={t(tab === "calls" ? "callsSoon" : features?.meetings ? "meetingsSoon" : "meetingsNotInPlan")} />
      )}
    </div>
  );
}
