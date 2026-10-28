import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import { answerStartupPermissions, readStartupPermissions } from "../../core/services/StartupPermissions";
import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";

// Owner 2026-10-28: "all the permissions at the start, each with what it is
// for". Shown once on the phone after signing in; Android's own dialogs
// follow "Continue" (location, camera, notifications), one after another.
const ITEMS = ["location", "camera", "notifications"] as const;

export default function StartupPermissionsPrompt() {
  const { profile } = useAuth();
  const { t } = useTranslation("shell");
  const [open, setOpen] = useState(() => readStartupPermissions() === "unknown");
  const [busy, setBusy] = useState(false);
  if (!profile || !open) return null;

  const answer = async (value: "accepted" | "declined") => {
    setBusy(true);
    setOpen(false);
    await answerStartupPermissions(value);
  };

  return (
    <Modal isOpen onClose={() => void answer("declined")} title={t("startupPermissions.title")}>
      <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)", lineHeight: 1.7, color: "var(--text-secondary)" }}>{t("startupPermissions.intro")}</p>
      {ITEMS.map((item) => (
        <div key={item} style={{ marginBottom: "var(--space-3)" }}>
          <p style={{ margin: 0, fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>{t(`startupPermissions.${item}.title`)}</p>
          <p style={{ margin: "var(--space-1) 0 0", fontSize: "var(--font-sm)", lineHeight: 1.7, color: "var(--text-primary)" }}>{t(`startupPermissions.${item}.body`)}</p>
        </div>
      ))}
      <p style={{ margin: "0 0 var(--space-4)", fontSize: "var(--font-xs)", lineHeight: 1.6, color: "var(--text-secondary)" }}>{t("startupPermissions.footer")}</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
        <Button variant="ghost" disabled={busy} onClick={() => void answer("declined")}>
          {t("startupPermissions.decline")}
        </Button>
        <Button disabled={busy} onClick={() => void answer("accepted")}>
          {t("startupPermissions.accept")}
        </Button>
      </div>
    </Modal>
  );
}
