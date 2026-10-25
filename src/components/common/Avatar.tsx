import { useEffect, useState } from "react";

import PeopleDirectoryRepository from "../../core/repositories/PeopleDirectoryRepository";
import styles from "./Avatar.module.css";

export type AvatarSize = "xs" | "sm" | "md" | "lg";

const PIXELS: Record<AvatarSize, number> = { xs: 20, sm: 28, md: 36, lg: 56 };

function initialOf(name: string): string {
  const first = name.trim().charAt(0);
  return first ? first.toLocaleUpperCase() : "?";
}

// v2.3.43 step 14 (item 17): one avatar everywhere a name appears - the
// person's PROFILE photo (users.avatar_url, never an attendance evidence
// photo), or their initial. Give `url` when the list already has it; with
// only `userId` the photo comes from the shared people directory (only for
// people the reader may see - checked on the server). A broken link falls
// back to the initial.
export default function Avatar({ name, url, userId, size = "sm", className }: { name: string; url?: string | null; userId?: string | null; size?: AvatarSize; className?: string }) {
  const [resolved, setResolved] = useState<string | null>(url ?? null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
    if (url !== undefined) {
      setResolved(url);
      return undefined;
    }
    if (!userId) {
      setResolved(null);
      return undefined;
    }
    let cancelled = false;
    PeopleDirectoryRepository.avatarOf(userId).then((found) => {
      if (!cancelled) setResolved(found);
    });
    return () => {
      cancelled = true;
    };
  }, [url, userId]);

  const pixels = PIXELS[size];
  const showImage = Boolean(resolved) && !broken;
  return (
    <span
      className={[styles.avatar, className].filter(Boolean).join(" ")}
      style={{ width: pixels, height: pixels, fontSize: Math.max(10, Math.round(pixels * 0.42)) }}
      aria-hidden="true"
    >
      {showImage ? <img src={resolved ?? undefined} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} /> : initialOf(name)}
    </span>
  );
}
