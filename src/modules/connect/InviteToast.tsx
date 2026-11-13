import { useTranslation } from "react-i18next";
import { Users, Video, X } from "lucide-react";

import type { ConnectPerson } from "../../core/repositories/ConnectRepository";
import type { MeetingInvite } from "./engine/ConnectEngine";
import GlassButton from "./GlassButton";
import styles from "./InviteToast.module.css";

// PROSM Connect: an invitation to a meeting, wherever the person is in the app.
export default function InviteToast({ invite, people, onJoin, onDismiss }: { invite: MeetingInvite; people: Map<string, ConnectPerson>; onJoin: () => void; onDismiss: () => void }) {
  const { t } = useTranslation("connect");
  const from = people.get(invite.fromUser)?.fullName ?? "";
  return (
    <div className={styles.toast} role="alertdialog" aria-label={t("meeting.invited", { name: from })}>
      <span className={styles.icon} aria-hidden="true">{invite.media === "video" ? <Video size={18} /> : <Users size={18} />}</span>
      <span className={styles.text}>
        <b>{t("meeting.invited", { name: from })}</b>
        <small>{invite.title ?? t(invite.media === "video" ? "meeting.videoTitle" : "meeting.audioTitle")}</small>
      </span>
      <button type="button" className={styles.join} onClick={onJoin}>{t("meeting.join")}</button>
      <GlassButton label={t("meeting.dismiss")} size="small" onClick={onDismiss}><X size={14} /></GlassButton>
    </div>
  );
}
