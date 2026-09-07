import { MUSIC_DIR, MUSIC_FILES, type MusicId } from './config'

export type MusicOptions = {
  /** 0..1 track gain (default 0.8). */
  volume?: number
  /** Crossfade/fade duration in ms (default 500). */
  fadeMs?: number
}

const MUSIC_MUTE_KEY = 'adea:audio:music-muted'
const LEGACY_MUTE_KEY = 'adea:audio:muted'
const DEFAULT_MUSIC_VOLUME = 0.8
const FADE_STEP_MS = 30

function clampVolume(value: number): number {
  return value <= 0 ? 0 : value > 1 ? 1 : value
}

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, muted: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (muted) window.localStorage.setItem(key, '1')
    else window.localStorage.removeItem(key)
  } catch {
    // Storage can be unavailable; the in-memory mute still applies.
  }
}

function loadMusicMuted(): boolean {
  return readStorage(MUSIC_MUTE_KEY) === '1' || readStorage(LEGACY_MUTE_KEY) === '1'
}

export class SoundController {
  private musicElements = new Map<MusicId, HTMLAudioElement>()
  private desiredMusic: MusicId | null = null
  private currentMusic: MusicId | null = null
  private activeFades = new Set<number>()
  private _musicMuted: boolean

  constructor() {
    this._musicMuted = loadMusicMuted()
  }

  get musicMuted(): boolean {
    return this._musicMuted
  }

  /** Retry queued playback after a user gesture. */
  async unlock(): Promise<void> {
    this.startDesiredMusic()
  }

  /** Start or switch to a looping soundtrack. */
  playMusic(id: MusicId, options: MusicOptions = {}): void {
    if (!MUSIC_FILES[id]) return
    this.desiredMusic = id
    this.prepareMusicElement(id)
    if (!this.musicMuted) this.startMusic(id, options)
  }

  setMusicMuted(muted: boolean): void {
    this._musicMuted = muted
    writeStorage(MUSIC_MUTE_KEY, muted)
    for (const element of this.musicElements.values()) {
      if (muted) element.pause()
    }
    if (!muted) this.startDesiredMusic()
  }

  toggleMusicMute(): boolean {
    this.setMusicMuted(!this._musicMuted)
    return this._musicMuted
  }

  private prepareMusicElement(id: MusicId): void {
    if (this.musicElements.has(id)) return
    const element = new Audio(`${MUSIC_DIR}/${MUSIC_FILES[id]}`)
    element.loop = true
    // Defer the request until playback is allowed so audio never competes with
    // the scene's first visual and physics assets.
    element.preload = 'none'
    this.musicElements.set(id, element)
  }

  private startMusic(id: MusicId, options: MusicOptions = {}): void {
    if (this.currentMusic === id) {
      const active = this.musicElements.get(id)
      if (active?.paused) void active.play().catch(() => undefined)
      return
    }

    const fadeMs = options.fadeMs ?? 500
    const target = clampVolume(options.volume ?? DEFAULT_MUSIC_VOLUME)
    const previousId = this.currentMusic
    const previous = previousId ? (this.musicElements.get(previousId) ?? null) : null
    this.currentMusic = id
    const element = this.musicElements.get(id)
    if (!element) return
    element.volume = 0
    element.currentTime = 0
    void element
      .play()
      .then(() => {
        if (this.currentMusic !== id) {
          element.pause()
          return
        }
        if (previous) {
          this.fadeMusic(previous, 0, fadeMs, () => {
            previous.pause()
            previous.currentTime = 0
          })
        }
        this.fadeMusic(element, target, fadeMs)
      })
      .catch(() => {
        // Autoplay is blocked before the first user gesture. Keep the desired
        // track so unlock() can retry it later.
        if (previous) this.currentMusic = previousId
        else this.currentMusic = null
      })
  }

  private startDesiredMusic(): void {
    if (this.musicMuted || !this.desiredMusic) return
    const desired = this.desiredMusic
    if (this.currentMusic !== desired) {
      this.startMusic(desired)
      return
    }
    const element = this.musicElements.get(desired)
    if (element?.paused) void element.play().catch(() => undefined)
  }

  private fadeMusic(
    element: HTMLAudioElement,
    target: number,
    durationMs: number,
    onDone?: () => void
  ): void {
    const start = element.volume
    const startTime = performance.now()
    const interval = window.setInterval(() => {
      const progress = Math.min(1, (performance.now() - startTime) / Math.max(durationMs, 1))
      element.volume = start + (target - start) * progress
      if (progress >= 1) {
        window.clearInterval(interval)
        this.activeFades.delete(interval)
        onDone?.()
      }
    }, FADE_STEP_MS)
    this.activeFades.add(interval)
  }
}

export const soundController = new SoundController()
