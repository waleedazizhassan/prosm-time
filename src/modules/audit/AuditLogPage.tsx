import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";

import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import DateRange from "../../components/common/DateRange";
import ErrorText from "../../components/common/ErrorText";
import FieldRow from "../../components/common/FieldRow";
import Input from "../../components/common/Input";
import PageBanner from "../../components/common/PageBanner";
import PageShell from "../../components/common/PageShell";
import Select from "../../components/common/Select";
import Table, { type TableColumn } from "../../components/common/Table";
import { useAuth } from "../../core/context/AuthContext";
import DashboardRepository, { type DashboardAuditRow } from "../../core/repositories/DashboardRepository";
import EmployeeRepository from "../../core/repositories/EmployeeRepository";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import SiteRepository from "../../core/repositories/SiteRepository";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import savePdfDocument, { exportFileName } from "../../core/utils/savePdfDocument";
import { AUDIT_GROUP_PATTERNS, auditLabel } from "../dashboard/manager/dashboardLogic";
import reportsHeaderImage from "../../assets/illustrations/reports.svg";
import { buildAuditLogPdf } from "./auditLogPdf";

const PAGE = 50;
const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

// Owner 2026-10-28 ("does the action log have to sit on the dashboard? -
// move it"): the action log on its own page - who did what to whom, when,
// where and why - filtered by period, person and kind, a page at a time,
// with a PDF. The Owner sees the organisation's; whoever holds audit.view
// what concerns the people they may see (the server decides).
export default function AuditLogPage() {
  const { t, i18n } = useTranslation("dashboard");
  const { t: tCommon } = useTranslation("common");
  const { profile, hasPermission } = useAuth();
  const allowed = Boolean(profile?.isOwner) || hasPermission("audit.view");

  const today = new Date();
  const [from, setFrom] = useState(localDay(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(localDay(today));
  const [person, setPerson] = useState("");
  const [kind, setKind] = useState("");
  const [rows, setRows] = useState<DashboardAuditRow[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [siteNames, setSiteNames] = useState(new Map<string, string>());
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    EmployeeRepository.listOrganizationMembers().then((result) => setPeople((result.data ?? []).map((member) => ({ id: member.id, name: member.fullName }))));
    SiteRepository.listSites().then((result) => setSiteNames(new Map((result.data ?? []).map((site) => [site.id, site.name]))));
  }, [allowed]);

  const load = useCallback(
    async (before: string | null) => {
      setLoading(true);
      setError("");
      const result = await DashboardRepository.listAuditLog({ from, to, userId: person || null, pattern: kind ? AUDIT_GROUP_PATTERNS[kind] : null, before, limit: PAGE });
      setLoading(false);
      if (!result.success) {
        setError(humanizeBackendError(result.message, tCommon) ?? t("auditPage.loadError"));
        return;
      }
      const page = result.data ?? [];
      setRows((current) => (before ? [...current, ...page] : page));
      setMore(page.length === PAGE);
    },
    [from, to, person, kind, t, tCommon],
  );

  useEffect(() => {
    if (allowed) void load(null);
  }, [allowed, load]);

  const when = useCallback((iso: string) => `${formatDateOnly(iso, i18n.language)} ${formatTimeOnly(iso, i18n.language)}`, [i18n.language]);

  const columns: TableColumn<DashboardAuditRow>[] = useMemo(
    () => [
      { key: "time", header: t("manager.audit.columns.time"), render: (row) => when(row.created_at) },
      { key: "actor", header: t("manager.audit.columns.actor"), render: (row) => row.actor_name ?? t("manager.audit.system") },
      { key: "action", header: t("manager.audit.columns.action"), render: (row) => auditLabel(row.action, t) },
      { key: "subject", header: t("manager.audit.columns.subject"), render: (row) => row.subject_name ?? "—" },
      { key: "site", header: t("manager.audit.columns.site"), render: (row) => (row.site_id && siteNames.get(row.site_id)) ?? "—" },
      { key: "reason", header: t("manager.audit.columns.reason"), render: (row) => row.reason ?? "—" },
    ],
    [t, when, siteNames],
  );

  if (!allowed) return <Navigate to="/dashboard" replace />;

  const exportPdf = async () => {
    setExporting(true);
    try {
      const organization = await OrganizationRepository.getCurrentOrganization();
      const doc = await buildAuditLogPdf(rows, from, to, i18n.language, t, when, siteNames, organization.data?.logoUrl ?? null);
      await savePdfDocument(doc, exportFileName(t("auditPage.title"), from, to), "auditLog", from, to);
    } finally {
      setExporting(false);
    }
  };

  return (
    <PageShell title="">
      <PageBanner pageId="auditLog" illustration={reportsHeaderImage} />

      <Card title={t("auditPage.filters")}>
        <FieldRow>
          <DateRange>
            <Input label={t("auditPage.from")} name="auditFrom" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            <Input label={t("auditPage.to")} name="auditTo" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </DateRange>
          <Select label={t("auditPage.person")} name="auditPerson" value={person} onChange={(event) => setPerson(event.target.value)} options={[{ value: "", label: t("auditPage.everyone") }, ...people.map((member) => ({ value: member.id, label: member.name }))]} />
          <Select
            label={t("auditPage.kind")}
            name="auditKind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            options={[{ value: "", label: t("auditPage.allKinds") }, ...Object.keys(AUDIT_GROUP_PATTERNS).map((group) => ({ value: group, label: t(`manager.audit.groups.${group}`) }))]}
          />
        </FieldRow>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <Button onClick={exportPdf} loading={exporting} disabled={rows.length === 0}>
            {t("auditPage.exportPdf")}
          </Button>
        </div>
      </Card>

      <Card>
        <ErrorText>{error}</ErrorText>
        <Table columns={columns} data={rows} getRowId={(row) => row.id} loading={loading && rows.length === 0} emptyMessage={t("manager.audit.empty")} />
        {more ? (
          <div style={{ marginTop: "var(--space-3)", textAlign: "center" }}>
            <Button variant="ghost" onClick={() => load(rows[rows.length - 1]?.created_at ?? null)} loading={loading}>
              {t("auditPage.loadMore")}
            </Button>
          </div>
        ) : null}
      </Card>
    </PageShell>
  );
}
