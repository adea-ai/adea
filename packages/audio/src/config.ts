/** Optional soundtrack hooks for Agent HQ. */
export const AUDIO_BASE_URL = '/assets/audio'
export const MUSIC_DIR = `${AUDIO_BASE_URL}/sounds/music`

export const MUSIC_FILES = {
  silent: '',
} as const

export type MusicId = keyof typeof MUSIC_FILES
