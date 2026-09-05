import { invoke } from "@tauri-apps/api/core";

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "installing"
  | "installed"
  | "failed";

export type DesktopUpdate = {
  current_version: string;
  available_version: string | null;
  release_date: string | null;
  release_notes: string | null;
  changelog: string;
  github_url: string;
  phase: DesktopUpdatePhase;
  downloaded_bytes: number;
  total_bytes: number | null;
  error: string | null;
  restart_required: boolean;
};

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getDesktopUpdateStatus(): Promise<DesktopUpdate> {
  return invoke<DesktopUpdate>("desktop_update_status");
}

export function checkDesktopUpdate(): Promise<DesktopUpdate> {
  return invoke<DesktopUpdate>("desktop_update_check");
}

export function installDesktopUpdate(expectedVersion: string): Promise<DesktopUpdate> {
  return invoke<DesktopUpdate>("desktop_update_install", {
    expectedVersion,
    approved: true,
    restart: true,
  });
}
