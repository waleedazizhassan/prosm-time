import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

import PeopleDirectoryRepository, { type DirectoryPerson } from "../../core/repositories/PeopleDirectoryRepository";

import Avatar from "../../components/common/Avatar";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import StatusBadge from "../../components/common/StatusBadge";
import LoadingState from "../../components/common/LoadingState";
import EmptyState from "../../components/common/EmptyState";
import styles from "./PeopleByRole.module.css";

// The groups, in order: managers (the Owner with them), supervisors,
// employees, viewers, then any other role by its own order and name.
function groupOf(person: DirectoryPerson): { key: string; sort: number; label: string | null } {
  if (person.isOwner || person.roleKey === "owner" || person.roleKey === "manager") return { key: "managers", sort: 20, label: null };
  if (person.roleKey === "supervisor") return { key: "supervisors", sort: 30, label: null };
  if (person.roleKey === "employee") return { key: "employees", sort: 40, label: null };
  if (person.roleKey === "read_only") return { key: "viewers", sort: 50, label: null };
  return { key: `role:${person.roleKey}`, sort: person.roleSort, label: person.roleName };
}

const STATUS_BADGE: Record<DirectoryPerson["presence"], string> = { in: "active", break: "pending", out: "inactive" };

// v2.3.43 step 15 (item 18): people grouped by role - title, count,
// collapse, alphabetical inside a group; one search (name, role, site) and
// filters (site, status, shift today) across all groups, with "no results".
// Rows: avatar, name, role, site, shift, status. `compact` is the manager's
// lighter list. Only people the reader may see (scoped on the server).
export default function PeopleByRole({ compact = false, onOpen }: { compact?: boolean; onOpen?: (person: DirectoryPerson) => void }) {
  const { t, i18n } = useTranslation("people");
  const [people, setPeople] = useState<DirectoryPerson[] | null>(null);
  const [query, setQuery] = useState("");
  const [site, setSite] = useState("");
  const [status, setStatus] = useState("");
  const [shift, setShift] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    PeopleDirectoryRepository.list(true).then(setPeople);
  }, []);

  const collator = useMemo(() => new Intl.Collator(i18n.language), [i18n.language]);
  const sites = useMemo(() => {
    const all = new Map<string, string>();
    for (const person of people ?? []) person.siteIds.forEach((id, index) => all.set(id, person.siteNames[index] ?? ""));
    return [...all.entries()].sort((a, b) => collator.compare(a[1], b[1]));
  }, [people, collator]);

  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = (people ?? []).filter((person) => {
      if (site && !person.siteIds.includes(site)) return false;
      if (status && person.presence !== status) return false;
      if (shift === "today" && !person.shiftStart) return false;
      if (shift === "none" && person.shiftStart) return false;
      if (!needle) return true;
      return [person.fullName, person.roleName, ...person.siteNames, person.currentSiteName ?? ""].some((value) => value.toLocaleLowerCase().includes(needle));
    });
    const byGroup = new Map<string, { key: string; sort: number; label: string | null; people: DirectoryPerson[] }>();
    for (const person of filtered) {
      const group = groupOf(person);
      if (!byGroup.has(group.key)) byGroup.set(group.key, { ...group, people: [] });
      byGroup.get(group.key)!.people.push(person);
    }
    return [...byGroup.values()]
      .map((group) => ({ ...group, people: group.people.sort((a, b) => collator.compare(a.fullName, b.fullName)) }))
      .sort((a, b) => a.sort - b.sort || collator.compare(a.label ?? a.key, b.label ?? b.key));
  }, [people, query, site, status, shift, collator]);

  if (!people) return <LoadingState />;

  return (
    <div className={styles.wrapper}>
      <div className={styles.filters}>
        <Input label={t("byRole.search")} name="peopleSearch" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("byRole.searchPlaceholder")} />
        {/* the dashboard's short list keeps only the search (owner 2026-10-26) */}
        {compact ? null : (
          <>
        <Select label={t("byRole.site")} name="peopleSite" value={site} onChange={(event) => setSite(event.target.value)} options={[{ value: "", label: t("byRole.all") }, ...sites.map(([id, name]) => ({ value: id, label: name }))]} />
        <Select
          label={t("byRole.status")}
          name="peopleStatus"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          options={[{ value: "", label: t("byRole.all") }, ...(["in", "break", "out"] as const).map((value) => ({ value, label: t(`byRole.presence.${value}`) }))]}
        />
        <Select
          label={t("byRole.shift")}
          name="peopleShift"
          value={shift}
          onChange={(event) => setShift(event.target.value)}
          options={[
            { value: "", label: t("byRole.all") },
            { value: "today", label: t("byRole.shiftToday") },
            { value: "none", label: t("byRole.noShift") },
          ]}
        />
          </>
        )}
      </div>

      {groups.length === 0 ? <EmptyState kind="notFound" message={t("byRole.noResults")} /> : null}

      {groups.map((group) => {
        const isCollapsed = Boolean(collapsed[group.key]);
        return (
          <section key={group.key} className={styles.group}>
            <button type="button" className={styles.groupHeader} aria-expanded={!isCollapsed} onClick={() => setCollapsed((all) => ({ ...all, [group.key]: !isCollapsed }))}>
              <span className={styles.groupTitle}>{group.label ?? t(`byRole.groups.${group.key}`)}</span>
              <span className={styles.count}>{group.people.length}</span>
              <ChevronDown size={18} className={isCollapsed ? styles.chevronClosed : styles.chevron} aria-hidden="true" />
            </button>
            {isCollapsed ? null : (
              <ul className={compact ? `${styles.list} ${styles.compact}` : styles.list}>
                {group.people.map((person) => (
                  <li key={person.id}>
                    <button type="button" className={styles.row} onClick={() => onOpen?.(person)} disabled={!onOpen}>
                      <Avatar name={person.fullName} url={person.avatarUrl} size={compact ? "sm" : "md"} />
                      <span className={styles.main}>
                        <span className={styles.name}>{person.fullName}</span>
                        <span className={styles.meta}>
                          {[person.isOwner ? t("ownerBadge") : person.roleName, person.currentSiteName ?? person.siteNames.join("، "), person.shiftStart ? `${person.shiftStart}–${person.shiftEnd}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      {person.isOwner ? null : <StatusBadge status={STATUS_BADGE[person.presence]}>{t(`byRole.presence.${person.presence}`)}</StatusBadge>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
