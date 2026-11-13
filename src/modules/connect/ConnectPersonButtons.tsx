import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { MessageCircle } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import GlassButton from "./GlassButton";
import useConnect from "./useConnect";

// PROSM Connect (owner 2026-11-13): beside a person in the people list and on their page - "message" now; the voice
// and video call buttons join when calls arrive (stage 5). Nothing shows without Connect, or for oneself.
export default function ConnectPersonButtons({ userId, name, size = "small" }: { userId: string; name: string; size?: "small" | "medium" }) {
  const { t } = useTranslation("connect");
  const { profile } = useAuth();
  const { on } = useConnect(profile?.id);
  const navigate = useNavigate();
  if (!on || !profile || userId === profile.id) return null;
  return (
    <GlassButton label={t("actions.message", { name })} tone="primary" size={size}
      onClick={(event) => { event.stopPropagation(); navigate(`/connect?to=${encodeURIComponent(userId)}`); }}>
      <MessageCircle size={size === "small" ? 16 : 18} />
    </GlassButton>
  );
}
