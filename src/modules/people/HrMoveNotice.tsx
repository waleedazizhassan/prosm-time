import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { requireSupabaseClient } from "../../core/api/supabaseClient";

// Owner 2026-11-16: the HR manager authority MOVES (20261117110000). Before giving it, say who loses it.
// Shows nothing when nobody else holds it or the server does not have the move yet.
export default function HrMoveNotice({ userId }: { userId: string }) {
  const { t } = useTranslation("people");
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void requireSupabaseClient().rpc("list_prosm_time_hr_manager_holders", { p_except: userId }).then(({ data, error }) => {
      if (alive && !error && Array.isArray(data)) setNames((data as { name: string }[]).map((h) => h.name));
    });
    return () => { alive = false; };
  }, [userId]);

  if (names.length === 0) return null;
  return (
    <p role="alert" style={{ margin: "var(--space-2) 0", padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-md)",
      background: "var(--status-warning-bg)", color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>
      {t("perms.hrMoves", { names: names.join("، ") })}
    </p>
  );
}
