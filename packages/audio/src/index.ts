// @agent-hq/audio: optional sound hooks for Agent HQ. Provides a shared
// SoundController, a scene track registry, and React bindings.

export { AUDIO_BASE_URL, MUSIC_FILES, SFX_FILES, type MusicId, type SfxId } from "./config";
export {
  SoundController,
  soundController,
  type LoopHandle,
  type MusicOptions,
  type SfxOptions,
} from "./controller";
export { musicForScene, sceneMusicTracks, unassignedTracks } from "./scene-music";
export { MiniGameAudio, type MiniGameAudioConfig } from "./minigame-audio";
export {
  MusicToggle,
  SfxToggle,
  SoundProvider,
  useSceneMusic,
  useSound,
  useStopMusic,
  type SoundContextValue,
} from "./react";
