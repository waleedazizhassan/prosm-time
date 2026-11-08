import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import PeopleDirectoryRepository, { type DirectoryPerson } from "../../core/repositories/PeopleDirectoryRepository";
import OwnerAuthorityRepository, { type OwnerDelegation } from "../../core/repositories/OwnerAuthorityRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../core/utils/formatDate";

import PageShell from "../../components/common/PageShell";
import PageBanner from "../../components/common/PageBanner";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";
import StatusBadge from "../../components/common/StatusBadge";
import Avatar from "../../components/common/Avatar";
import HintText from "../../components/common/HintText";
import ErrorText from "../../components/common/ErrorText";
import EmptyState from "../../components/common/EmptyState";
import LoadingState from "../../components/common/LoadingState";
import permissionsImage from "../../assets/illustrations/state-permission.svg";

// Owner 2026-11-04: "Grant permissions" - the owner's own page. Each person with their role,
// a way to their permissions, and "Grant all": the owner's whole authority (every permission,
// owner-only actions, the owner's notifications and emails) until the owner withdraws it -
// then the person is back to their role and their own permissions. Every grant and withdrawal
// has a reason and is kept (governance).
export default function GrantPermissionsPage() {
  const { t, i18n } = useTranslation("people");
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [people, setPeople] = useState<DirectoryPerson[] | null>(null);
  const [grants, setGrants] = useState<OwnerDelegation[]>([]);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<{ person: DirectoryPerson; action: "grant" | "revoke" } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [list, history] = await Promise.all([PeopleDirectoryRepository.list(true), OwnerAuthorityRepository.list()]);
    setPeople(list.filter((person) => !person.isOwner));
    setGrants(history);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(() => new Map(grants.filter((grant) => !grant.revokedAt).map((grant) => [grant.userId, grant])), [grants]);
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const collator = new Intl.Collator(i18n.language);
    return (people ?? [])
      .filter((person) => !needle || person.fullName.toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(active.has(b.id)) - Number(active.has(a.id)) || collator.compare(a.fullName, b.fullName));
  }, [people, query, active, i18n.language]);

  // only the owner as a person grants the owner's authority
  if (profile && !profile.isRealOwner) return <Navigate to="/dashboard" replace />;

  const submit = async () => {
    if (!target) return;
    if (!reason.trim()) {
      setError(t("ownerAuthority.reasonRequired"));
      return;
    }
    setBusy(true);
    setError("");
    const failed = target.action === "grant" ? await OwnerAuthorityRepository.grant(target.person.id, reason.trim()) : await OwnerAuthorityRepository.revoke(target.person.id, reason.trim());
    setBusy(false);
    if (failed) {
      setError(humanizeBackendError(failed, t) ?? t("ownerAuthority.failed"));
      return;
    }
    setTarget(null);
    setReason("");
    await load();
  };

  return (
    <PageShell title="">
      <PageBanner pageId="grantPermissions" illustration={permissionsImage} />
      <Card title={t("ownerAuthority.title")} subtitle={t("ownerAuthority.hint")}>
        <Input label={t("ownerAuthority.search")} name="grantSearch" value={query} onChange={(event) => setQuery(event.target.value)} />
        {people === null ? <LoadingState /> : null}
        {people !== null && shown.length === 0 ? <EmptyState message={t("ownerAuthority.nobody")} /> : null}
        <ul style={{ listStyle: "none", margin: "var(--space-3) 0 0", padding: 0, display: "grid", gap: "var(--space-2)" }}>
          {shown.map((person) => {
            const grant = active.get(person.id);
            return (
              <li key={person.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-3)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)" }}>
                <Avatar name={person.fullName} url={person.avatarUrl} size="md" />
                <div style={{ flex: "1 1 12rem", minWidth: 0 }}>
                  <strong>{person.fullName}</strong>
                  <HintText small>
                    {t(`common:roles.${person.roleKey}`, { defaultValue: person.roleName })}
                    {grant ? ` · ${t("ownerAuthority.since", { date: formatDateOnly(grant.grantedAt.slice(0, 10), i18n.language) })}` : ""}
                  </HintText>
                </div>
                {grant ? <StatusBadge status="active">{t("ownerAuthority.hasAll")}</StatusBadge> : null}
                <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/people/${person.id}`)}>
                    {t("ownerAuthority.permissions")}
                  </Button>
                  {grant ? (
                    <Button size="sm" variant="danger" onClick={() => { setTarget({ person, action: "revoke" }); setReason(""); setError(""); }}>
                      {t("ownerAuthority.revokeAll")}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => { setTarget({ person, action: "grant" }); setReason(""); setError(""); }} disabled={!person.isActive}>
                      {t("ownerAuthority.grantAll")}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {grants.length > 0 ? (
        <Card title={t("ownerAuthority.historyTitle")} subtitle={t("ownerAuthority.historyHint")}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
            {grants.map((grant) => (
              <li key={grant.id} style={{ fontSize: "var(--font-sm)", paddingBottom: "var(--space-2)", borderBottom: "1px solid var(--border-light)" }}>
                <strong>{grant.userName}</strong> · {t("ownerAuthority.grantedLine", { date: formatDateOnly(grant.grantedAt.slice(0, 10), i18n.language), reason: grant.reason })}
                {grant.revokedAt ? (
                  <div style={{ color: "var(--text-secondary)" }}>{t("ownerAuthority.revokedLine", { date: formatDateOnly(grant.revokedAt.slice(0, 10), i18n.language), reason: grant.revokeReason ?? "" })}</div>
                ) : (
                  <div style={{ color: "var(--status-success-text)" }}>{t("ownerAuthority.stillActive")}</div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Modal
        isOpen={Boolean(target)}
        onClose={() => setTarget(null)}
        title={target ? t(target.action === "grant" ? "ownerAuthority.grantTitle" : "ownerAuthority.revokeTitle", { name: target.person.fullName }) : ""}
        footer={
          <Button variant={target?.action === "revoke" ? "danger" : "primary"} onClick={submit} loading={busy}>
            {target?.action === "revoke" ? t("ownerAuthority.revokeAll") : t("ownerAuthority.grantAll")}
          </Button>
        }
      >
        <HintText small>{target?.action === "grant" ? t("ownerAuthority.grantExplain") : t("ownerAuthority.revokeExplain")}</HintText>
        <Textarea label={t("ownerAuthority.reasonLabel")} name="ownerAuthorityReason" value={reason} onChange={(event) => setReason(event.target.value)} />
        <ErrorText>{error}</ErrorText>
      </Modal>
    </PageShell>
  );
}
