import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import i18n from "../../i18n";
import { startPush, updatePushLanguage } from "../../core/services/PushService";
import notificationTarget from "../../core/utils/notificationTarget";
import { readStartupPermissions, STARTUP_PERMISSIONS_EVENT } from "../../core/services/StartupPermissions";

// Owner 2026-10-18/20: once signed in, the Android app registers for push
// notifications; tapping one opens the page it is about. Mounted once in
// the app shell.
export default function PushRegistration() {
  const { profile, hasPermission } = useAuth();
  const navigate = useNavigate();
  const profileId = profile?.id;
  // Owner 2026-10-20: the same page the bell opens (notificationTarget), for
  // whoever is signed in when the notification is tapped.
  const viewerRef = useRef({ isOwner: false, canViewEmergencyLog: false });
  useEffect(() => {
    viewerRef.current = { isOwner: Boolean(profile?.isOwner), canViewEmergencyLog: hasPermission("attendance.view") };
  });

  // Owner 2026-10-28: on the phone the start screen asks for notifications
  // with the other permissions; registering waits for its answer and never
  // asks again after "Not now".
  const [startupAnswer, setStartupAnswer] = useState(readStartupPermissions);
  useEffect(() => {
    const sync = () => setStartupAnswer(readStartupPermissions());
    window.addEventListener(STARTUP_PERMISSIONS_EVENT, sync);
    return () => window.removeEventListener(STARTUP_PERMISSIONS_EVENT, sync);
  }, []);

  useEffect(() => {
    if (profileId && startupAnswer !== "unknown") void startPush((data) => navigate(notificationTarget(data, viewerRef.current)), startupAnswer === "accepted");
  }, [profileId, navigate, startupAnswer]);

  useEffect(() => {
    const onLanguage = () => void updatePushLanguage();
    i18n.on("languageChanged", onLanguage);
    return () => i18n.off("languageChanged", onLanguage);
  }, []);

  return null;
}
