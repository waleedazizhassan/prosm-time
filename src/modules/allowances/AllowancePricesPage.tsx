import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import AllowanceRatesRepository, { EMPTY_RATES, RATE_FIELDS, type AllowanceCategory, type RateRow, type RateScope, type Rates } from "../../core/repositories/AllowanceRatesRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import PageShell from "../../components/common/PageShell";
import PageBanner from "../../components/common/PageBanner";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Table, { type TableColumn } from "../../components/common/Table";
import ErrorText from "../../components/common/ErrorText";
import allowancesHeaderImage from "../../assets/illustrations/allowances.svg";

const EVERY_SITE = "";

interface Editing {
  scope: RateScope;
  title: string;
  // Only for a category or a person: the site can be chosen in the form.
  chooseSite: boolean;
}

// Owner 2026-10-20 ("allowances like my PROSM Allow app, only easier"): one
// page to price allowances - per site, per category of staff (engineers,
// technicians, workers...) and per person; the later wins, a blank price
// inherits, and an allowance priced at zero is typed by the employee. A
// worked day fills itself from these prices (20261020260000).
export default function AllowancePricesPage() {
  const { t } = useTranslation("allowances");
  const navigate = useNavigate();
  const { profile, hasPermission } = useAuth();
  const isOwner = Boolean(profile?.isOwner);
  const canPrice = isOwner || hasPermission("allowances.approve");

  const [sites, setSites] = useState<Site[]>([]);
  const [managedSiteIds, setManagedSiteIds] = useState<Set<string> | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [rates, setRates] = useState<RateRow[]>([]);
  const [categories, setCategories] = useState<AllowanceCategory[]>([]);
  const [memberCategory, setMemberCategory] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");

  const [editing, setEditing] = useState<Editing | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [formSiteId, setFormSiteId] = useState(EVERY_SITE);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [categoryEditing, setCategoryEditing] = useState<AllowanceCategory | { id: null; name: string } | null>(null);
  const [categoryError, setCategoryError] = useState("");

  const load = useCallback(async () => {
    const [sitesResult, membersResult, ratesResult, categoriesResult, membersCategoryResult, managedResult] = await Promise.all([
      SiteRepository.listSites(),
      EmployeeRepository.listOrganizationMembers(),
      AllowanceRatesRepository.listRates(),
      AllowanceRatesRepository.listCategories(),
      AllowanceRatesRepository.listCategoryMembers(),
      isOwner || !profile?.id ? Promise.resolve(null) : SiteRepository.listManagedSiteIds(profile.id),
    ]);
    const failed = [sitesResult, membersResult, ratesResult, categoriesResult].find((result) => !result.success);
    setLoadError(failed ? humanizeBackendError(failed.message, t) ?? t("prices.loadError") : "");
    setSites(sitesResult.data ?? []);
    setMembers((membersResult.data ?? []).filter((member) => member.isActive && !member.isOwner));
    setRates(ratesResult.data ?? []);
    setCategories(categoriesResult.data ?? []);
    setMemberCategory(membersCategoryResult.data ?? {});
    setManagedSiteIds(managedResult && managedResult.success ? new Set(managedResult.data ?? []) : null);
  }, [isOwner, profile?.id, t]);

  useEffect(() => {
    if (canPrice) load();
  }, [canPrice, load]);

  // A manager prices only the sites they manage.
  const priceableSites = useMemo(() => (managedSiteIds ? sites.filter((site) => managedSiteIds.has(site.id)) : sites), [sites, managedSiteIds]);
  const siteName = useCallback((siteId: string | null) => (siteId ? sites.find((site) => site.id === siteId)?.name ?? "—" : t("prices.everySite")), [sites, t]);
  const ratesFor = (scope: RateScope) =>
    rates.find((row) => row.siteId === scope.siteId && row.categoryId === scope.categoryId && row.userId === scope.userId)?.rates ?? EMPTY_RATES;

  const openEditor = (scope: RateScope, title: string, chooseSite = false) => {
    const current = ratesFor(scope);
    setEditing({ scope, title, chooseSite });
    setFormSiteId(scope.siteId ?? (isOwner ? EVERY_SITE : priceableSites[0]?.id ?? EVERY_SITE));
    setForm(Object.fromEntries(RATE_FIELDS.map((field) => [field, current[field] === null ? "" : String(current[field])])));
    setFormError("");
  };

  // Choosing another site in the form shows that scope's current prices.
  const changeFormSite = (siteId: string) => {
    if (!editing) return;
    setFormSiteId(siteId);
    const current = ratesFor({ ...editing.scope, siteId: siteId || null });
    setForm(Object.fromEntries(RATE_FIELDS.map((field) => [field, current[field] === null ? "" : String(current[field])])));
  };

  const save = async () => {
    if (!editing) return;
    const next = { ...EMPTY_RATES } as Rates;
    for (const field of RATE_FIELDS) {
      const raw = (form[field] ?? "").trim();
      if (raw === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        setFormError(t("prices.invalidPrice"));
        return;
      }
      next[field] = value;
    }
    setSaving(true);
    setFormError("");
    const scope = editing.chooseSite ? { ...editing.scope, siteId: formSiteId || null } : editing.scope;
    const result = await AllowanceRatesRepository.setRates(scope, next);
    setSaving(false);
    if (!result.success) {
      setFormError(humanizeBackendError(result.message, t) ?? t("prices.saveError"));
      return;
    }
    setEditing(null);
    await load();
  };

  const saveCategory = async () => {
    if (!categoryEditing) return;
    setCategoryError("");
    const result = await AllowanceRatesRepository.saveCategory(categoryEditing.id, categoryEditing.name);
    if (!result.success) {
      setCategoryError(humanizeBackendError(result.message, t) ?? t("prices.saveError"));
      return;
    }
    setCategoryEditing(null);
    await load();
  };

  const deleteCategory = async (category: AllowanceCategory) => {
    if (!window.confirm(t("prices.deleteCategoryConfirm", { name: category.name }))) return;
    const result = await AllowanceRatesRepository.deleteCategory(category.id);
    if (!result.success) setLoadError(humanizeBackendError(result.message, t) ?? t("prices.saveError"));
    await load();
  };

  const changeMemberCategory = async (userId: string, categoryId: string) => {
    const result = await AllowanceRatesRepository.setCategoryMember(userId, categoryId || null);
    if (!result.success) setLoadError(humanizeBackendError(result.message, t) ?? t("prices.saveError"));
    await load();
  };

  const money = (value: number | null) => (value === null ? "—" : value.toFixed(2));
  const priceColumns = <T,>(get: (row: T) => Rates): TableColumn<T>[] =>
    RATE_FIELDS.map((field) => ({ key: field, header: t(`prices.field.${field}`), render: (row: T) => money(get(row)[field]) }));

  const siteColumns: TableColumn<Site>[] = [
    { key: "site", header: t("columns.site"), render: (site) => site.name },
    ...priceColumns<Site>((site) => ratesFor({ siteId: site.id, categoryId: null, userId: null })),
    {
      key: "edit",
      header: "",
      render: (site) => (
        <Button size="sm" variant="ghost" onClick={() => openEditor({ siteId: site.id, categoryId: null, userId: null }, site.name)}>
          {t("prices.editAction")}
        </Button>
      ),
    },
  ];

  const categoryRows = rates.filter((row) => row.categoryId !== null);
  const personRows = rates.filter((row) => row.userId !== null);
  const scopeColumns = (nameOf: (row: RateRow) => string): TableColumn<RateRow>[] => [
    { key: "who", header: t("prices.forColumn"), render: nameOf },
    { key: "site", header: t("columns.site"), render: (row) => siteName(row.siteId) },
    ...priceColumns<RateRow>((row) => row.rates),
    {
      key: "edit",
      header: "",
      render: (row) => (
        <Button size="sm" variant="ghost" onClick={() => openEditor({ siteId: row.siteId, categoryId: row.categoryId, userId: row.userId }, nameOf(row))}>
          {t("prices.editAction")}
        </Button>
      ),
    },
  ];
  const categoryName = (row: RateRow) => categories.find((category) => category.id === row.categoryId)?.name ?? "—";
  const personName = (row: RateRow) => members.find((member) => member.id === row.userId)?.fullName ?? "—";

  const memberColumns: TableColumn<OrgMember>[] = [
    { key: "name", header: t("columns.employee"), render: (member) => member.fullName },
    {
      key: "category",
      header: t("prices.categoryColumn"),
      render: (member) => (
        <select style={{ minHeight: 36, padding: "0 var(--space-2)", border: "1px solid var(--border-medium)", borderRadius: "var(--radius-sm)", background: "var(--surface-raised)", color: "var(--text-primary)", font: "inherit" }} value={memberCategory[member.id] ?? ""} onChange={(event) => changeMemberCategory(member.id, event.target.value)} aria-label={t("prices.categoryColumn")}>
          <option value="">{t("prices.noCategory")}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: "own",
      header: "",
      render: (member) => (
        <Button size="sm" variant="ghost" onClick={() => openEditor({ siteId: null, categoryId: null, userId: member.id }, member.fullName, true)}>
          {t("prices.personalAction")}
        </Button>
      ),
    },
  ];

  if (!canPrice) {
    return (
      <PageShell title="">
        <PageBanner pageId="allowances" illustration={allowancesHeaderImage} />
        <Card>
          <p>{t("prices.notAllowed")}</p>
        </Card>
      </PageShell>
    );
  }

  const siteOptions = [...(isOwner ? [{ value: EVERY_SITE, label: t("prices.everySite") }] : []), ...priceableSites.map((site) => ({ value: site.id, label: site.name }))];

  return (
    <PageShell title="">
      <PageBanner pageId="allowances" illustration={allowancesHeaderImage} />
      <Card
        title={t("prices.title")}
        subtitle={t("prices.howItWorks")}
        actions={
          <Button variant="ghost" onClick={() => navigate("/allowances")}>
            {t("prices.backToAllowances")}
          </Button>
        }
      >
        <ErrorText>{loadError}</ErrorText>
      </Card>

      <Card title={t("prices.sitesTitle")} subtitle={t("prices.sitesHint")} flush>
        <Table columns={siteColumns} data={priceableSites} getRowId={(site) => site.id} emptyMessage={t("prices.noSites")} />
      </Card>

      <Card
        title={t("prices.categoriesTitle")}
        subtitle={t("prices.categoriesHint")}
        actions={
          <Button size="sm" onClick={() => setCategoryEditing({ id: null, name: "" })}>
            {t("prices.addCategory")}
          </Button>
        }
      >
        {categories.length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("prices.noCategories")}</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
            {categories.map((category) => (
              <span key={category.id} style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)", padding: "4px 6px 4px 12px", border: "1px solid var(--border-light)", borderRadius: "var(--radius-full)", background: "var(--surface-raised)" }}>
                <strong style={{ fontSize: "var(--font-sm)" }}>{category.name}</strong>
                <Button size="xs" variant="ghost" onClick={() => openEditor({ siteId: null, categoryId: category.id, userId: null }, category.name, true)}>
                  {t("prices.editAction")}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setCategoryEditing(category)}>
                  {t("prices.renameAction")}
                </Button>
                {isOwner ? (
                  <Button size="xs" variant="ghost" onClick={() => deleteCategory(category)}>
                    {t("prices.deleteAction")}
                  </Button>
                ) : null}
              </span>
            ))}
          </div>
        )}
        {categoryRows.length > 0 ? (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Table columns={scopeColumns(categoryName)} data={categoryRows} getRowId={(row) => row.id} emptyMessage="" />
          </div>
        ) : null}
      </Card>

      <Card title={t("prices.peopleTitle")} subtitle={t("prices.peopleHint")} flush>
        <Table columns={memberColumns} data={members} getRowId={(member) => member.id} emptyMessage={t("prices.noPeople")} />
        {personRows.length > 0 ? (
          <div style={{ padding: "var(--space-4)" }}>
            <Table columns={scopeColumns(personName)} data={personRows} getRowId={(row) => row.id} emptyMessage="" />
          </div>
        ) : null}
      </Card>

      <Modal
        isOpen={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing ? t("prices.editTitle", { name: editing.title }) : ""}
        footer={
          <Button onClick={save} loading={saving}>
            {t("prices.saveAction")}
          </Button>
        }
      >
        {editing?.chooseSite ? (
          <Select label={t("columns.site")} name="priceSite" value={formSiteId} onChange={(event) => changeFormSite(event.target.value)} options={siteOptions} />
        ) : null}
        <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("prices.blankInherits")}</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "var(--space-3)" }}>
          {RATE_FIELDS.map((field) => (
            <Input
              key={field}
              label={t(`prices.field.${field}`)}
              name={`price-${field}`}
              type="number"
              value={form[field] ?? ""}
              placeholder="—"
              onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))}
            />
          ))}
        </div>
        <ErrorText>{formError}</ErrorText>
      </Modal>

      <Modal
        isOpen={Boolean(categoryEditing)}
        onClose={() => setCategoryEditing(null)}
        title={categoryEditing?.id ? t("prices.renameAction") : t("prices.addCategory")}
        footer={<Button onClick={saveCategory}>{t("prices.saveAction")}</Button>}
      >
        <Input
          label={t("prices.categoryName")}
          name="categoryName"
          value={categoryEditing?.name ?? ""}
          placeholder={t("prices.categoryExample")}
          onChange={(event) => setCategoryEditing((current) => (current ? { ...current, name: event.target.value } : current))}
        />
        <ErrorText>{categoryError}</ErrorText>
      </Modal>
    </PageShell>
  );
}
