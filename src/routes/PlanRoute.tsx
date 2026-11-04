import type { ReactNode } from "react";

import { useAuth } from "../core/context/AuthContext";
import usePlanFeatures, { type PlanFeature } from "../core/hooks/usePlanFeatures";
import PageShell from "../components/common/PageShell";
import Card from "../components/common/Card";
import PlanLockedNote from "../components/common/PlanLockedNote";

// Owner 2026-11-04 ("close it on the server and hide what doesn't work"): a page outside the
// organisation's plan shows that it is part of another plan - even opened from a link or a
// notification - instead of its buttons. The server refuses it either way.
const BUSINESS: PlanFeature[] = ["kiosk", "leave", "export", "approvals", "on_behalf", "allowances", "scheduling", "clock_rules", "roles_manager", "payroll_export"];

export default function PlanRoute({ feature, children }: { feature: PlanFeature; children: ReactNode }) {
  const { profile } = useAuth();
  const { plan, allows } = usePlanFeatures(profile?.id);
  if (!plan || allows(feature)) return <>{children}</>;
  return (
    <PageShell title="">
      <Card>
        <PlanLockedNote plan={BUSINESS.includes(feature) ? "business" : "pro"} />
      </Card>
    </PageShell>
  );
}
