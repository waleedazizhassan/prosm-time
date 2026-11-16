import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { requireSupabaseClient } from "../../core/api/supabaseClient";

// Owner 2026-11-16: an administration's authority (HR, finance, ...) MOVES (20261117110000). Before giving a whole
// set, say who loses it. Nothing shows when nobody else manages it or the server does not have the move yet.
export default function ManagementMoveNotice({ userId, set }: { userId: string; set: string }) {
  const { t } = useTranslation("people");
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void requireSupabaseClient().rpc("list_prosm_time_management_holders", { p_set: set, p_except: userId }).then(({ data, error }) => {
      if (alive && !error && Array.isArray(data)) setNames((data as { name: string }[]).map((h) => h.name));
    });
    return () => { alive = false; };
  }, [userId, set]);

  if (names.length === 0) return null;
  return (
    <p role="alert" style={{ margin: "var(--space-2) 0", padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-md)",
      background: "var(--status-warning-bg)", color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>
      {t("perms.setMoves", { names: names.join("، "), set: t(`bundles.${set}.title`) })}
    </p>
  );
}
