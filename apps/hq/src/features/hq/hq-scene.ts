import type { SceneManifest } from "@agent-hq/asset-manifests";
import { hqHomeManifest } from "@agent-hq/scene-hq-home";
import { hqWorkManifest } from "@agent-hq/scene-hq-work";

export const hqScenes = {
  "hq-home": hqHomeManifest,
  "hq-work": hqWorkManifest,
} as const satisfies Record<"hq-home" | "hq-work", SceneManifest>;

export type HqSceneId = keyof typeof hqScenes;

export function hqSceneLabel(sceneId: HqSceneId): string {
  return hqScenes[sceneId].label;
}
