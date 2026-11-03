import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import DatabaseManager from "../../core/database/DatabaseManager";
import { useAuth } from "../../core/context/AuthContext";
import { LANGUAGE_CODES } from "../../i18n/languages";

// Owner 2026-11-03: emails and their PDFs go out in each person's own language. The app
// tells the server the language it is shown in, when it opens and whenever it changes.
export default function LanguageSync() {
  const { i18n } = useTranslation();
  const { profile } = useAuth();
  const language = i18n.language?.slice(0, 2);

  useEffect(() => {
    if (!profile?.id || !language || !LANGUAGE_CODES.includes(language)) return;
    void Promise.resolve(DatabaseManager.getClient().rpc("set_prosm_time_my_language", { p_language: language })).catch(() => undefined);
  }, [profile?.id, language]);

  return null;
}
