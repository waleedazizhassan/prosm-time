import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";

import Button from "../../components/common/Button";
import InviteEmployeeModal from "./InviteEmployeeModal";

// PROSM Time Implementation Master File V3.0, WP-04/§37 - "Employee
// Management." Real org-member list (RLS-scoped) with an Invite action
// gated on the real 'employees.create' permission - hasPermission()
// only hides the button, the invite-user Edge Function itself
// re-checks this server-side (§9).
export default function PeoplePage() {
  const { t } = useTranslation("people");
  const { hasPermission } = useAuth();

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const result = await EmployeeRepository.listOrganizationMembers();
    if (!result.success) {
      setLoadError(result.message ?? t("loadError"));
      setMembers([]);
      setLoading(false);
      return;
    }
    setMembers(result.data ?? []);
    setLoading(false);
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  if (!hasPermission("employees.view")) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "2rem 1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>{t("title")}</h1>
        {hasPermission("employees.create") ? <Button onClick={() => setInviteOpen(true)}>{t("invite.actionLabel")}</Button> : null}
      </div>
      <p style={{ color: "var(--text-secondary)", marginBottom: "0.5rem" }}>{t("subtitle")}</p>
      <Link to="/dashboard" style={{ color: "var(--accent-light)", fontSize: "0.85rem" }}>
        {t("backToDashboard")}
      </Link>

      {loadError ? <p style={{ color: "var(--danger)" }}>{loadError}</p> : null}

      {loading ? (
        <p>…</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
              <th style={{ padding: "0.5rem" }}>{t("columns.name")}</th>
              <th style={{ padding: "0.5rem" }}>{t("columns.email")}</th>
              <th style={{ padding: "0.5rem" }}>{t("columns.role")}</th>
              <th style={{ padding: "0.5rem" }}>{t("columns.status")}</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "0.5rem" }}>
                  <Link to={`/people/${member.id}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>
                    {member.fullName}
                  </Link>
                  {member.isOwner ? (
                    <span style={{ marginLeft: "0.5rem", fontSize: "0.7rem", color: "var(--accent-light)", border: "1px solid var(--accent-light)", borderRadius: 4, padding: "0 4px" }}>
                      {t("ownerBadge")}
                    </span>
                  ) : null}
                </td>
                <td style={{ padding: "0.5rem", color: "var(--text-secondary)" }}>{member.email}</td>
                <td style={{ padding: "0.5rem", color: "var(--text-secondary)" }}>{member.roleName}</td>
                <td style={{ padding: "0.5rem", color: "var(--text-secondary)" }}>{t(`status.${member.status}`, { defaultValue: member.status })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <InviteEmployeeModal isOpen={inviteOpen} onClose={() => setInviteOpen(false)} onInvited={load} />
    </div>
  );
}
