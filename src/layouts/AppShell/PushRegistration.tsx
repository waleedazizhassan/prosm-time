import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import i18n from "../../i18n";
import { startPush, updatePushLanguage } from "../../core/services/PushService";

// Owner 2026-10-18/20: once signed in, the Android app registers for push
// notifications; tapping one opens the page it is about. Mounted once in
// the app shell.
export default function PushRegistration() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const profileId = profile?.id;

  useEffect(() => {
    if (profileId) void startPush((path) => navigate(path));
  }, [profileId, navigate]);

  useEffect(() => {
    const onLanguage = () => void updatePushLanguage();
    i18n.on("languageChanged", onLanguage);
    return () => i18n.off("languageChanged", onLanguage);
  }, []);

  return null;
}
