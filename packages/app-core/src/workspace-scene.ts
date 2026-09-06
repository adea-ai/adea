import type { WorkspaceSceneId } from "@adea-ai/types";

export type HqSceneId = WorkspaceSceneId;

export function hqSceneFromSearchParams(params: { scene?: string | string[] }): HqSceneId {
  const scene = Array.isArray(params.scene) ? params.scene[0] : params.scene;
  return scene === "work" ? "work" : "home";
}
