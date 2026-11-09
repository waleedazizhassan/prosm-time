import { useTranslation } from "react-i18next";

import PageShell from "../../components/common/PageShell";
import ExceptionsCard from "./ExceptionsCard";

// Owner 2026-11-09: "the exceptions go in the sidebar" - the clock-in screen stays one screen; the
// out-of-area moments to explain have their own page (notifications open it).
export default function ExceptionsPage() {
  const { t } = useTranslation("shell");
  return (
    <PageShell title={t("items.exceptions")}>
      <ExceptionsCard showEmpty />
    </PageShell>
  );
}
