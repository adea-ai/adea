import {
  VersionDialog as SharedVersionDialog,
  type VersionDialogAdapter,
} from "@agent-hq/ui/components/version-dialog";

import { checkDesktopUpdate, getDesktopUpdateStatus, installDesktopUpdate } from "./desktop-update";

const desktopUpdateAdapter: VersionDialogAdapter = {
  check: checkDesktopUpdate,
  getStatus: getDesktopUpdateStatus,
  install: installDesktopUpdate,
  isDesktopRuntime: () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
};

export function VersionDialog() {
  return <SharedVersionDialog adapter={desktopUpdateAdapter} fallbackVersion="0.7.2" />;
}
