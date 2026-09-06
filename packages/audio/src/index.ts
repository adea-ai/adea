// Optional soundtrack hooks for Adea.

export { AUDIO_BASE_URL, MUSIC_FILES, type MusicId } from "./config";
export { SoundController, soundController, type MusicOptions } from "./controller";
export { musicForScene, sceneMusicTracks } from "./scene-music";
export {
  MusicToggle,
  SoundProvider,
  useSceneMusic,
  useSound,
  type SoundContextValue,
} from "./react";
