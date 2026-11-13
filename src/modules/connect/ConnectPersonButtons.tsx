import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { MessageCircle, Phone, Video } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import { useConnectContext } from "./ConnectProvider";
import GlassButton from "./GlassButton";
import useConnect from "./useConnect";

// PROSM Connect (owner 2026-11-13): beside a person in the people list and on their page - message, voice call and
// video call. Nothing shows without Connect, or for oneself; calls only with the plan's calls.
export default function ConnectPersonButtons({ userId, name, size = "small" }: { userId: string; name: string; size?: "small" | "medium" }) {
  const { t } = useTranslation("connect");
  const { profile } = useAuth();
  const { on, features } = useConnect(profile?.id);
  const connect = useConnectContext();
  const navigate = useNavigate();
  if (!on || !profile || userId === profile.id) return null;
  const icon = size === "small" ? 16 : 18;
  return (
    <>
      <GlassButton label={t("actions.message", { name })} tone="primary" size={size}
        onClick={(event) => { event.stopPropagation(); navigate(`/connect?to=${encodeURIComponent(userId)}`); }}>
        <MessageCircle size={icon} />
      </GlassButton>
      {features?.calls && connect ? (
        <>
          <GlassButton label={t("actions.audioCall")} size={size} onClick={(event) => { event.stopPropagation(); void connect.startCall(userId, "audio"); }}><Phone size={icon} /></GlassButton>
          <GlassButton label={t("actions.videoCall")} size={size} onClick={(event) => { event.stopPropagation(); void connect.startCall(userId, "video"); }}><Video size={icon} /></GlassButton>
        </>
      ) : null}
    </>
  );
}
