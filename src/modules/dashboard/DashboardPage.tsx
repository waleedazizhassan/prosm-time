import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";

import PageShell from "../../components/common/PageShell";
import ClockInOutCard from "./ClockInOutCard";
import ExceptionsCard from "./ExceptionsCard";
import KioskPinCard from "./KioskPinCard";

// PROSM Time Implementation Master File V3.0, WP-03/§21/§37 - "Admin
// Dashboard." Deliberately minimal and operational: real-time
// attendance is the actual point of this screen (§37). Organization
// identity and the read-only reflection of PROSM Management's license
// state still exist in full - § final visual consistency pass,
// correction moved them out of two large Dashboard cards into a
// compact Header quick-look (HeaderOrganizationCard), consistent with
// PROSM Platform's own Header/OrganizationCard pattern, so this screen
// stays focused on what an employee actually does here. Sign-out and
// cross-page navigation live in the application shell (Sidebar/User
// Menu, Header) - this page only owns its own operational content.
export default function DashboardPage() {
  const { t } = useTranslation("dashboard");
  const { profile } = useAuth();

  return (
    <PageShell title={t("title")} subtitle={profile ? t("welcomeMessage", { name: profile.fullName }) : undefined}>
      <ClockInOutCard />
      <ExceptionsCard />
      <KioskPinCard />
    </PageShell>
  );
}
