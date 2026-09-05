import type { MusicId } from "./config";

/** Scene route id -> optional track. Deployments can add tracks without changing scene code. */
export const sceneMusicTracks: Record<string, MusicId> = {
  "hq-home": "silent",
  "hq-work": "silent",
};

export function musicForScene(sceneId: string | null | undefined): MusicId {
  return sceneMusicTracks[sceneId ?? ""] ?? "silent";
}
