import { defineAgentHqConfig } from "@agent-hq/config";

export const desktopAppConfig = defineAgentHqConfig({
  platform: "desktop",
  apiBaseUrl: "/api",
});

export const desktopShellCapabilities = [
  "local-harness-discovery",
  "acp-connectivity",
  "filesystem",
  "process-management",
  "secure-credential-storage",
  "deep-links",
  "notifications",
  "auto-update",
] as const;
