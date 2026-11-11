import type { LucideIcon } from "lucide-react";
import { CameraOff, CircleCheckBig, Hourglass, Inbox, Lock, LogIn, MapPinOff, RefreshCw, SearchX, ServerCrash, TriangleAlert, Upload, WifiOff } from "lucide-react";

import type { StateKind } from "../../core/utils/errorKind";

// Owner 2026-11-12 ("the same pictures repeated everywhere; replace the one with a person bowing by a check
// mark"): an empty list shows one calm, consistent sign - an icon fitting the situation in a soft circle -
// instead of the same drawing on every page. The drawings stay for full-page messages and dialogs.
export const STATE_ICON: Record<StateKind, LucideIcon> = {
  empty: Inbox,
  success: CircleCheckBig,
  waiting: Hourglass,
  notFound: SearchX,
  error: TriangleAlert,
  offline: WifiOff,
  permission: Lock,
  location: MapPinOff,
  camera: CameraOff,
  session: LogIn,
  sync: RefreshCw,
  upload: Upload,
  server: ServerCrash,
};
