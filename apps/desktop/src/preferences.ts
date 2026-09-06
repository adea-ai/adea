import { invoke } from "@tauri-apps/api/core";
import type { WorkspacePreferences, WorkspaceSettingsProvider } from "@adea-ai/workspace-ui";

export const desktopSettingsProvider: WorkspaceSettingsProvider = Object.freeze({
  load() {
    return invoke<WorkspacePreferences>("desktop_preferences_load");
  },
  save(preferences) {
    return invoke<WorkspacePreferences>("desktop_preferences_save", { preferences });
  },
});
