import {
  defaultWorkspacePreferences,
  type WorkspacePreferences,
  type WorkspaceSettingsProvider,
} from "./platform";

export function normalizeWorkspacePreferences(value: unknown): WorkspacePreferences {
  if (!value || typeof value !== "object") return defaultWorkspacePreferences;
  const candidate = value as Partial<WorkspacePreferences>;
  return Object.freeze({
    dictationLocale:
      typeof candidate.dictationLocale === "string"
        ? candidate.dictationLocale.trim().slice(0, 35)
        : "",
    notifyMentions: typeof candidate.notifyMentions === "boolean" ? candidate.notifyMentions : true,
    notifyTasks: typeof candidate.notifyTasks === "boolean" ? candidate.notifyTasks : true,
    privateNotificationPreviews:
      typeof candidate.privateNotificationPreviews === "boolean"
        ? candidate.privateNotificationPreviews
        : false,
    version: 1,
  });
}

export function createBrowserSettingsProvider(
  storage?: Pick<Storage, "getItem" | "setItem">
): WorkspaceSettingsProvider {
  const key = "agent-hq:workspace-preferences:v1";
  const resolveStorage = () => storage ?? window.localStorage;
  return Object.freeze({
    async load() {
      try {
        return normalizeWorkspacePreferences(JSON.parse(resolveStorage().getItem(key) ?? "null"));
      } catch {
        return defaultWorkspacePreferences;
      }
    },
    async save(preferences) {
      const normalized = normalizeWorkspacePreferences(preferences);
      resolveStorage().setItem(key, JSON.stringify(normalized));
      return normalized;
    },
  });
}
