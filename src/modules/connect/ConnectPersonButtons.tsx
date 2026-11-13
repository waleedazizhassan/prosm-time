import { useTranslation } from "react-i18next";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { MessageCircle, Phone, Video } from "lucide-react";

import { useConnectContext } from "./ConnectProvider";
import GlassButton from "./GlassButton";

// PROSM Connect (owner 2026-11-13): beside a person in the people list and on their page - message, voice call and
// video call. Nothing shows without Connect (no provider, or a plan without it), or for oneself; calls only with the
// plan's calls.
export default function ConnectPersonButtons(props: { userId: string; name: string; size?: "small" | "medium" }) {
  const connect = useConnectContext();
  const inRouter = useInRouterContext();
  if (!inRouter || !connect?.on || !connect.meId || props.userId === connect.meId) return null;
  return <Buttons {...props} />;
}

function Buttons({ userId, name, size = "small" }: { userId: string; name: string; size?: "small" | "medium" }) {
  const { t } = useTranslation("connect");
  const connect = useConnectContext()!;
  const navigate = useNavigate();
  const icon = size === "small" ? 16 : 18;
  return (
    <>
      <GlassButton label={t("actions.message", { name })} tone="primary" size={size}
        onClick={(event) => { event.stopPropagation(); navigate(`/connect?to=${encodeURIComponent(userId)}`); }}>
        <MessageCircle size={icon} />
      </GlassButton>
      {connect.canCall ? (
        <>
          <GlassButton label={t("actions.audioCall")} size={size} onClick={(event) => { event.stopPropagation(); void connect.startCall(userId, "audio"); }}><Phone size={icon} /></GlassButton>
          <GlassButton label={t("actions.videoCall")} size={size} onClick={(event) => { event.stopPropagation(); void connect.startCall(userId, "video"); }}><Video size={icon} /></GlassButton>
        </>
      ) : null}
    </>
  );
}
