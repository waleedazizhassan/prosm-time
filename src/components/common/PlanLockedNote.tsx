import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";

// Owner 2026-11-03: a feature outside the organisation's plan says so, in place of the
// feature, and the owner gets a way to the plan card.
export default function PlanLockedNote({ plan }: { plan: "business" | "pro" }) {
  const { t } = useTranslation("common");
  const { profile } = useAuth();
  return (
    <p style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap", margin: 0, fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
      <Lock size={14} aria-hidden="true" />
      <span>{t("planLocked.text", { plan: plan === "pro" ? "Pro" : "Business" })}</span>
      {profile?.isOwner ? <Link to="/settings#plan">{t("planLocked.seePlan")}</Link> : <span>{t("planLocked.askOwner")}</span>}
    </p>
  );
}
