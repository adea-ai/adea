import { Capacitor } from "@capacitor/core";

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
