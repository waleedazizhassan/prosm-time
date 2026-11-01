import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import Input from "../../components/common/Input";
import Modal from "../../components/common/Modal";

interface KioskAddSiteModalProps {
  isOpen: boolean;
  sites: Site[];
  onClose: () => void;
  onAdded: () => void;
  onCreateNew: () => void;
}

// Plan stage 4.1: the sites already registered, with a search and several at
// once; creating a new one is the second choice. A site added here keeps its
// app use too (both_allowed).
export default function KioskAddSiteModal({ isOpen, sites, onClose, onAdded, onCreateNew }: KioskAddSiteModalProps) {
  const { t } = useTranslation("kiosk");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? sites.filter((site) => site.name.toLowerCase().includes(query)) : sites;
  }, [search, sites]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const add = async () => {
    setSaving(true);
    setError("");
    const results = await Promise.all([...selected].map((id) => SiteRepository.updateSite(id, { kioskMode: "both_allowed" })));
    setSaving(false);
    if (results.some((result) => !result.success)) {
      setError(t("launcher.addError"));
      return;
    }
    onAdded();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t("launcher.addTitle")}>
      {sites.length > 0 ? <Input name="kioskSiteSearch" label={t("launcher.search")} value={search} onChange={(event) => setSearch(event.target.value)} /> : <p>{t("launcher.noSites")}</p>}
      <div style={{ maxHeight: 280, overflowY: "auto", margin: "var(--space-2) 0" }}>
        {visible.map((site) => (
          <label key={site.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minHeight: 44, cursor: "pointer" }}>
            <input type="checkbox" checked={selected.has(site.id)} onChange={() => toggle(site.id)} />
            <span>{site.name}</span>
          </label>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "var(--space-2)" }}>
        <Button variant="ghost" onClick={onCreateNew}>
          {t("launcher.createNew")}
        </Button>
        <Button onClick={add} loading={saving} disabled={selected.size === 0 || saving}>
          {t("launcher.addSelected")}
        </Button>
      </div>
    </Modal>
  );
}
