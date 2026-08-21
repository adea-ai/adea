import { MUSIC_FILES, type MusicId } from "./config";

/** Scene route id -> optional track. Deployments can add tracks without changing scene code. */
export const sceneMusicTracks: Record<string, MusicId> = {
  "hq-home": "silent",
  "hq-work": "silent",
};

export const unassignedTracks: MusicId[] = [];

export function musicForScene(_sceneId: string | null | undefined): MusicId {
  return "silent" in MUSIC_FILES ? "silent" : (Object.keys(MUSIC_FILES)[0] as MusicId);
}
