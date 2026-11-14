import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useAuth } from "../../core/context/AuthContext";
import ConnectRepository, { type ConnectPerson } from "../../core/repositories/ConnectRepository";
import { ConnectEngine, type IncomingCall, type MeetingInvite } from "./engine/ConnectEngine";
import type { LocalMessage } from "./engine/localStore";
import { CallSession } from "./engine/CallSession";
import { messageAlert } from "./engine/sounds";
import { MeetingSession } from "./engine/MeetingSession";
import useConnect from "./useConnect";
import CallScreen from "./CallScreen";
import MeetingScreen from "./MeetingScreen";
import InviteToast from "./InviteToast";

// PROSM Connect (owner 2026-11-13): one place, alive across the whole app while the person is signed in - the engine
// that receives and sends, the call that rings wherever the person is in the app, the meeting in progress, and an
// invitation that pops up. Nothing of it runs without Connect.

interface ConnectContextValue {
  on: boolean;
  meId: string | null;
  canCall: boolean;
  people: Map<string, ConnectPerson>;
  call: CallSession | null;
  meeting: MeetingSession | null;
  startCall: (peerId: string, media: "audio" | "video") => Promise<void>;
  startMeeting: (media: "audio" | "video", invitees: string[], title: string | null) => Promise<void>;
  joinMeeting: (meetingId: string) => Promise<void>;
  error: string | null;
  clearError: () => void;
}

const ConnectContext = createContext<ConnectContextValue | null>(null);

export function useConnectContext() {
  return useContext(ConnectContext);
}

export default function ConnectProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const { on, features } = useConnect(profile?.id);
  const [people, setPeople] = useState<Map<string, ConnectPerson>>(new Map());
  const [call, setCall] = useState<CallSession | null>(null);
  const [meeting, setMeeting] = useState<MeetingSession | null>(null);
  const [invite, setInvite] = useState<MeetingInvite | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!on || !profile) return undefined;
    void ConnectEngine.start(profile.id, profile.organizationId);
    void ConnectRepository.people().then((list) => setPeople(new Map(list.map((p) => [p.id, p]))));
    const offCall = ConnectEngine.on("incoming-call", (detail) => {
      const incoming = detail as IncomingCall;
      setCall((current) => {
        if (current && current.callId === incoming.callId) return current;
        if (current && !["ended", "failed", "missed", "rejected", "busy"].includes(current.state)) {
          // already in a call: the other one hears busy
          void ConnectEngine.supabase.rpc("prosm_time_connect_answer_call", { p_call: incoming.callId, p_action: "busy" });
          return current;
        }
        return CallSession.incoming(incoming.callId, incoming.fromUser, incoming.media);
      });
    });
    const offInvite = ConnectEngine.on("meeting-invite", (detail) => setInvite(detail as MeetingInvite));
    // push to talk plays by itself when the app is open (owner: like a walkie-talkie)
    const offTalk = ConnectEngine.on("message", (detail) => {
      const m = detail as LocalMessage;
      if (m.mine || document.visibilityState !== "visible") return;
      // owner 2026-11-14: a new message chimes / vibrates as chosen in the sound settings
      if (m.kind !== "push_to_talk") {
        messageAlert();
        return;
      }
      void ConnectEngine.blob(m.id).then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        void audio.play().catch(() => URL.revokeObjectURL(url));
      });
    });
    return () => {
      offCall();
      offInvite();
      offTalk();
    };
  }, [on, profile]);

  // signing out: stop, and the person's Connect data leaves this device (AuthContext clears the profile)
  useEffect(() => {
    if (profile) return;
    void ConnectEngine.stop();
  }, [profile]);

  const startCall = useCallback(async (peerId: string, media: "audio" | "video") => {
    if (!features?.calls) return;
    try {
      setCall(await CallSession.start(peerId, media));
    } catch (e) {
      console.error("PROSM Connect call:", e instanceof Error ? e.message : e);
      setError(e instanceof Error ? e.message : "call failed");
    }
  }, [features?.calls]);

  const startMeeting = useCallback(async (media: "audio" | "video", invitees: string[], title: string | null) => {
    try {
      setMeeting(await MeetingSession.start(media, invitees, title));
    } catch (e) {
      console.error("PROSM Connect meeting:", e instanceof Error ? e.message : e);
      setError(e instanceof Error ? e.message : "meeting failed");
    }
  }, []);

  const joinMeeting = useCallback(async (meetingId: string) => {
    try {
      const session = new MeetingSession(meetingId);
      await session.join();
      setMeeting(session);
      setInvite(null);
    } catch (e) {
      console.error("PROSM Connect meeting:", e instanceof Error ? e.message : e);
      setError(e instanceof Error ? e.message : "meeting failed");
    }
  }, []);

  const value = useMemo<ConnectContextValue>(() => ({
    on, meId: profile?.id ?? null, canCall: Boolean(features?.calls), people, call, meeting, startCall, startMeeting, joinMeeting, error, clearError: () => setError(null),
  }), [on, profile?.id, features?.calls, people, call, meeting, startCall, startMeeting, joinMeeting, error]);

  return (
    <ConnectContext.Provider value={value}>
      {children}
      {on && call ? <CallScreen session={call} people={people} onClose={() => setCall(null)} /> : null}
      {on && meeting ? <MeetingScreen session={meeting} people={people} onClose={() => setMeeting(null)} /> : null}
      {on && invite && !meeting ? <InviteToast invite={invite} people={people} onJoin={() => void joinMeeting(invite.meetingId)} onDismiss={() => setInvite(null)} /> : null}
    </ConnectContext.Provider>
  );
}
