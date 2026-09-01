import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getGreetingPeriod, type GreetingPeriod } from "../utils/greeting";

const RECHECK_INTERVAL_MS = 60 * 1000;

// Ported from PROSM Platform's own useGreeting (§ visual consistency
// pass, Header greeting). Re-checks the period once a minute (a
// greeting only changes at hour boundaries) so a session left open
// across a boundary updates on its own, not just on next page load.
// Translations live in the shared "common" namespace under
// "greeting.*", matching Platform's own placement.
export default function useGreeting(): { period: GreetingPeriod; label: string } {
  const { t } = useTranslation("common");
  const [period, setPeriod] = useState<GreetingPeriod>(() => getGreetingPeriod());

  useEffect(() => {
    const recompute = () => setPeriod(getGreetingPeriod());
    const timer = setInterval(recompute, RECHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return { period, label: t(`greeting.${period}`) };
}
