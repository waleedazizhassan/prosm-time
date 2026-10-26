import type { StateKind } from "../../core/utils/errorKind";

import error from "../../assets/illustrations/state-error.svg";
import offline from "../../assets/illustrations/state-offline.svg";
import permission from "../../assets/illustrations/state-permission.svg";
import location from "../../assets/illustrations/state-location.svg";
import camera from "../../assets/illustrations/state-camera.svg";
import notFound from "../../assets/illustrations/state-not-found.svg";
import session from "../../assets/illustrations/state-session.svg";
import empty from "../../assets/illustrations/state-empty.svg";
import success from "../../assets/illustrations/state-success.svg";
import waiting from "../../assets/illustrations/state-waiting.svg";
import sync from "../../assets/illustrations/state-sync.svg";
import upload from "../../assets/illustrations/state-upload.svg";
import server from "../../assets/illustrations/state-server.svg";

// v2.3.43 step 21: one flat illustration per kind of message (unDraw, MIT,
// in the PROSM green - src/assets/illustrations/LICENSE.md).
export const STATE_ART: Record<StateKind, string> = {
  error,
  offline,
  permission,
  location,
  camera,
  notFound,
  session,
  empty,
  success,
  waiting,
  sync,
  upload,
  server,
};
