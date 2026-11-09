import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Megaphone } from "lucide-react";

import AnnouncementRepository from "../../core/repositories/AnnouncementRepository";
import { useDashboardRefresh } from "../../core/hooks/useDashboardRefresh";

// 2026-11-09 Media Center: on the home page, what is still to be read or confirmed - shown only then.
export default function UnreadAnnouncementsBanner() {
  const { t } = useTranslation("announcements");
  const [unread, setUnread] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  useDashboardRefresh(() => setRefreshKey((value) => value + 1));

  useEffect(() => {
    let alive = true;
    void AnnouncementRepository.mine().then((result) => {
      if (alive) setUnread(result.data?.unread ?? 0);
    });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (unread === 0) return null;
  return (
    <Link to="/announcements" role="status"
      style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "10px 14px", marginBottom: "var(--space-3)", borderRadius: 10, background: "var(--status-warning-bg, #fff7e6)", color: "var(--status-warning-text, #8a5300)", textDecoration: "none", fontWeight: 600 }}>
      <Megaphone size={18} aria-hidden="true" />
      <span>{t("banner", { count: unread })}</span>
    </Link>
  );
}
