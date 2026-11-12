import { useCallback, useEffect, useMemo, useState } from "react";
import DocumentTypesSettingsCard from "../settings/DocumentTypesSettingsCard";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Tabs from "../../components/common/Tabs";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import SuccessText from "../../components/common/SuccessText";
import Input from "../../components/common/Input";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../core/utils/formatDate";
import { toCsv } from "../../core/utils/spreadsheet";
import saveGeneratedFile from "../../core/utils/saveGeneratedFile";
import DocumentsRepository, { type DocumentsOverview, type DocumentsOverviewRow, type DocumentStatus } from "../../core/repositories/DocumentsRepository";
import { NEEDS_ACTION, STATUS_BADGE, statusText } from "./documentUi";

type View = "action" | "all";
type Tile = "expired" | "expiring" | "missing" | "pendingReview";
const TILE_STATUS: Record<Tile, DocumentStatus> = { expired: "expired", expiring: "expiring", missing: "missing", pendingReview: "pending_review" };

// HR suite feature 2: the company's documents in one place - what has expired, what expires soon, what is
// missing and what waits for review; one tap reminds the person, a row opens their file on its documents.
export default function DocumentsPage() {
  const { t, i18n } = useTranslation("documents");
  const navigate = useNavigate();
  const [data, setData] = useState<DocumentsOverview | null>(null);
  const [view, setView] = useState<View>("action");
  const [filter, setFilter] = useState<Tile | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const r = await DocumentsRepository.overview();
    if (r.error) setError(humanizeBackendError(r.error, t) ?? t("loadError"));
    setData(r.data ?? { expired: 0, expiring: 0, missing: 0, pendingReview: 0, completePercent: 100, action: [], all: [] });
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const source = (view === "action" ? data?.action : data?.all) ?? [];
    const q = search.trim().toLowerCase();
    return source.filter((r) => (!filter || r.status === TILE_STATUS[filter]) && (!q || `${r.name} ${r.typeName} ${r.site ?? ""}`.toLowerCase().includes(q)));
  }, [data, view, filter, search]);

  const remind = async (row: DocumentsOverviewRow) => {
    setBusy(row.id);
    setError("");
    setNotice("");
    const r = await DocumentsRepository.remind(row.id);
    setBusy("");
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("actionError"));
    setNotice(t("remindedName", { name: row.name }));
    await load();
  };

  const exportCsv = async () => {
    const header = [t("columns.person"), t("columns.site"), t("columns.document"), t("columns.status"), t("columns.expiry")];
    const body = rows.map((r) => {
      const s = statusText(r.status, r.daysLeft);
      return [r.name, r.site ?? "", r.typeName, t(s.key, { count: s.count }), r.expiryDate ?? ""];
    });
    await saveGeneratedFile(`${t("exportName")}.csv`, new Blob([toCsv([header, ...body])], { type: "text/csv;charset=utf-8" }));
  };

  const columns: TableColumn<DocumentsOverviewRow>[] = [
    { key: "name", header: t("columns.person"), render: (r) => <strong>{r.name}</strong>, sortValue: (r) => r.name },
    { key: "site", header: t("columns.site"), render: (r) => r.site ?? "—", sortValue: (r) => r.site ?? "" },
    { key: "doc", header: t("columns.document"), render: (r) => r.typeName, sortValue: (r) => r.typeName },
    {
      key: "status", header: t("columns.status"), sortValue: (r) => r.daysLeft ?? -9999,
      render: (r) => { const s = statusText(r.status, r.daysLeft); return <StatusBadge status={STATUS_BADGE[r.status]}>{t(s.key, { count: s.count })}</StatusBadge>; },
    },
    { key: "expiry", header: t("columns.expiry"), render: (r) => (r.expiryDate ? formatDateOnly(r.expiryDate, i18n.language) : "—"), sortValue: (r) => r.expiryDate ?? "" },
    {
      key: "do", header: "", render: (r) => (
        <span style={{ display: "inline-flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
          {r.status === "pending_review"
            ? <Button size="xs" onClick={() => navigate(`/people/${r.userId}?tab=documents`)}>{t("review")}</Button>
            : NEEDS_ACTION.includes(r.status) ? <Button size="xs" variant="ghost" loading={busy === r.id} onClick={() => void remind(r)}>{t("remind")}</Button> : null}
        </span>
      ),
    },
  ];

  const tiles: { key: Tile; value: number; tone: string }[] = data ? [
    { key: "expired", value: data.expired, tone: "expired" },
    { key: "expiring", value: data.expiring, tone: "pending" },
    { key: "missing", value: data.missing, tone: "suspended" },
    { key: "pendingReview", value: data.pendingReview, tone: "invited" },
  ] : [];

  return (
    <PageShell title={t("pageTitle")} subtitle={data ? t("completeLine", { percent: data.completePercent }) : undefined}
      actions={(
        <>
          <Button size="sm" variant="ghost" onClick={() => void exportCsv()} disabled={!rows.length}>{t("export")}</Button>
        </>
      )}>
      <ErrorText>{error}</ErrorText>
      {notice ? <SuccessText>{notice}</SuccessText> : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        {tiles.map((tile) => (
          <button key={tile.key} type="button" aria-pressed={filter === tile.key} onClick={() => setFilter(filter === tile.key ? null : tile.key)}
            style={{ textAlign: "start", padding: "var(--space-3)", borderRadius: "var(--radius-md)", cursor: "pointer", font: "inherit", color: "inherit",
              background: "var(--surface-card, var(--bg-card))", border: filter === tile.key ? "2px solid var(--brand-primary)" : "1px solid var(--border-light)" }}>
            <div style={{ fontSize: "1.6rem", fontWeight: 700 }}>{tile.value}</div>
            <StatusBadge status={tile.tone}>{t(`tiles.${tile.key}`)}</StatusBadge>
          </button>
        ))}
      </div>
      <Card>
        <Tabs items={[{ key: "action" as View, label: t("tabs.action"), badge: data?.action.length || undefined }, { key: "all" as View, label: t("tabs.all") }]}
          active={view} label={t("pageTitle")} onChange={setView} />
        <div style={{ maxWidth: 320, margin: "var(--space-2) 0" }}>
          <Input label={t("search")} name="docSearch" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Table columns={columns} data={rows} getRowId={(r) => r.id} loading={!data} grid
          emptyMessage={view === "action" ? t("nothingToDo") : t("noDocuments")}
          onRowClick={(r) => navigate(`/people/${r.userId}?tab=documents`)} />
      </Card>
      {/* owner 2026-11-12: the documents required of everyone (or of some job titles or sites) are set here, not
          in Settings; any other document is added from the person's file */}
      <DocumentTypesSettingsCard />
    </PageShell>
  );
}
