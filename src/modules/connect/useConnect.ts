import { useEffect, useState } from "react";

import { FEATURES } from "../../config/features";
import ConnectRepository, { type ConnectExtension, type ConnectFeatures } from "../../core/repositories/ConnectRepository";

// PROSM Connect (owner 2026-11-13): what the organisation has of Connect and everyone's internal number, read once
// per person and kept for a few minutes. Until it is known nothing of Connect shows (unlike other plan features,
// Connect never appears and then disappears).
let cached: Promise<{ features: ConnectFeatures; extensions: Map<string, string> }> | null = null;
let cachedFor: string | null = null;
let cachedAt = 0;
const MAX_AGE_MS = 5 * 60 * 1000;

function load(userKey: string) {
  if (cached && cachedFor === userKey && Date.now() - cachedAt < MAX_AGE_MS) return cached;
  cachedFor = userKey;
  cachedAt = Date.now();
  cached = (async () => {
    const features = await ConnectRepository.features();
    const extensions = features.enabled ? await ConnectRepository.extensions() : ([] as ConnectExtension[]);
    return { features, extensions: new Map(extensions.map((x) => [x.userId, x.ext])) };
  })();
  return cached;
}

export function resetConnect() {
  cached = null;
  cachedFor = null;
}

export default function useConnect(userKey: string | null | undefined) {
  const [state, setState] = useState<{ features: ConnectFeatures; extensions: Map<string, string> } | null>(null);
  useEffect(() => {
    if (!userKey || !FEATURES.connect) return undefined;
    let live = true;
    void load(userKey).then((result) => {
      if (live) setState(result);
    });
    return () => {
      live = false;
    };
  }, [userKey]);
  const on = Boolean(FEATURES.connect && state?.features.enabled);
  return { on, features: state?.features ?? null, extensionOf: (userId: string) => state?.extensions.get(userId) ?? null };
}
