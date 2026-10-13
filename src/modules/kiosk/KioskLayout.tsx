import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { Lock } from "lucide-react";

import AuthService from "../../core/auth/AuthService";
import { useAuth } from "../../core/context/AuthContext";
import Modal from "../../components/common/Modal";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import { lockKiosk, unlockKiosk } from "./kioskLock";
import styles from "./KioskLayout.module.css";

// Audit 1.3 (2026-10-13) - the kiosk used to sit inside the app shell, so
// anyone at the shared tablet could open the sidebar or the user menu and
// reach People, Settings or Clock On Behalf with the signed-in person's
// permissions. It now runs full screen with no navigation, no search and
// no user menu; leaving it needs the password of the account that opened
// it (checked by Supabase Auth, so it also works for a manager's account).
export default function KioskLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation("kiosk");
  const { siteId } = useParams<{ siteId: string }>();
  const { profile } = useAuth();
  const navigate = useNavigate();

  const [exitOpen, setExitOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (siteId) lockKiosk(siteId);
  }, [siteId]);

  const closeExit = () => {
    setExitOpen(false);
    setPassword("");
    setError("");
  };

  const handleExit = async (event: FormEvent) => {
    event.preventDefault();
    if (!profile?.email || !password) return;
    setChecking(true);
    setError("");
    const result = await AuthService.signIn(profile.email, password);
    setChecking(false);
    if (!result.success) {
      setError(/invalid login credentials/i.test(result.message ?? "") ? t("exit.wrongPassword") : t("exit.error"));
      return;
    }
    unlockKiosk();
    navigate("/kiosk", { replace: true });
  };

  return (
    <div className={styles.layout}>
      <button type="button" className={styles.exitButton} onClick={() => setExitOpen(true)}>
        <Lock size={14} />
        {t("exit.action")}
      </button>

      {children}

      <Modal isOpen={exitOpen} onClose={closeExit} title={t("exit.title")}>
        <form onSubmit={handleExit}>
          <p className={styles.prompt}>{t("exit.prompt", { email: profile?.email ?? "" })}</p>
          <Input
            label={t("exit.passwordLabel")}
            name="kiosk-exit-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={checking}
          />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" fullWidth loading={checking} disabled={!password || checking}>
            {t("exit.confirm")}
          </Button>
        </form>
      </Modal>
    </div>
  );
}
