import { useTranslation } from "react-i18next";

// PROSM Time Implementation Master File V3.0, WP-01 - Repository &
// Architecture Foundation. This is deliberately NOT the Splash Screen
// (§31, WP-21 - later in the execution order, §40 step 6) and contains
// no business logic: it exists only to prove the real toolchain (Vite +
// React + TypeScript + i18n, all wired to PROSM Time's own independent
// Supabase project once WP-02 lands) actually builds and runs before
// any real screen is built on top of it.
export default function App() {
  const { t } = useTranslation("common");

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>{t("appName")}</h1>
      <p>WP-01 foundation scaffold - architecture verified, no product screens yet.</p>
    </div>
  );
}
