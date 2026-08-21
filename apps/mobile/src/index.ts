import { defineAgentHqConfig } from "@agent-hq/config";
import { Capacitor } from "@capacitor/core";

export const mobileAppConfig = defineAgentHqConfig({
  platform: "mobile",
  apiBaseUrl: "/api",
});

export const mobileShellCapabilities = [
  "push-notifications",
  "camera-photos",
  "microphone",
  "secure-storage",
  "biometrics",
  "file-access",
  "share-sheet",
  "deep-links",
] as const;

export function isNativeMobileShell(): boolean {
  return Capacitor.isNativePlatform();
}
