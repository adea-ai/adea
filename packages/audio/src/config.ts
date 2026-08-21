/**
 * Optional sound hooks for Agent HQ. The scene runtime stays audio-capable,
 * while this repository currently ships no soundtrack or sound-effect assets.
 */
export const AUDIO_BASE_URL = "/assets/audio";
export const SFX_DIR = `${AUDIO_BASE_URL}/sounds/sfx`;
export const MUSIC_DIR = `${AUDIO_BASE_URL}/sounds/music`;

export const SFX_FILES = {
  jump: [],
  land: [],
  footstep: [],
  uiClick: [],
  waterLoop: [],
} as const;

export type SfxId = keyof typeof SFX_FILES;

export const MUSIC_FILES = {
  silent: "",
} as const;

export type MusicId = keyof typeof MUSIC_FILES;
