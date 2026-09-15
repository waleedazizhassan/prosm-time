import { useTranslation } from "react-i18next";

import PageShell from "../../components/common/PageShell";
import clockInOutBanner from "../../assets/illustration-clockinout-banner.jpg";
import ClockInOutCard from "../dashboard/ClockInOutCard";

// § user-directed - "the Owner/Manager shouldn't have the clock-in
// widget on their own Dashboard the way an Employee does - a sidebar
// entry that takes them to a dedicated page is more logical." Same
// ClockInOutCard every Employee already uses on their own Dashboard -
// this page is purely a different place to reach it from, not a
// second implementation.
export default function ClockInPage() {
  const { t } = useTranslation("dashboard");

  return (
    <PageShell title={t("clockInPage.title")} subtitle={t("clockInPage.subtitle")} bannerSrc={clockInOutBanner} compact>
      <ClockInOutCard />
    </PageShell>
  );
}
