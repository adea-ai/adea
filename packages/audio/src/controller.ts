// Global sound controller for Agent HQ. Sound assets are optional, so the
// scene can remain fully playable while a deployment supplies its own audio.
//
// Robustness rules (kept from the mini-game manager):
// - Missing assets are ignored: scenes stay fully playable if a fetch fails.
// - Music is never played before a user gesture; a desired track is queued and
//   starts as soon as the AudioContext unlocks (or the player unmutes).
// - SFX are throttled per id so rapid footsteps do not pile up sources.

import { MUSIC_DIR, MUSIC_FILES, SFX_DIR, SFX_FILES, type MusicId, type SfxId } from "./config";

export type SfxOptions = {
  /** 0..1 output gain (default 1). */
  volume?: number;
  /** Added playback rate for pitch variety (e.g. -0.1..0.1). */
  pitch?: number;
  /** Ignore repeat plays of the same id within this many ms. */
  throttleMs?: number;
};

export type MusicOptions = {
  /** 0..1 track gain (default 0.8). */
  volume?: number;
  /** Crossfade/fade duration in ms (default 500). */
  fadeMs?: number;
};

/** Control handle for a looping ambience cue started with playLoop. */
export type LoopHandle = {
  /** Stop the loop and release its audio nodes. Safe to call more than once. */
  stop: () => void;
  /** Adjust the loop gain live (0..1). Applied to an in-flight loop immediately. */
  setVolume: (volume: number) => void;
};

const MUSIC_MUTE_KEY = "agent-hq:audio:music-muted";
const SFX_MUTE_KEY = "agent-hq:audio:sfx-muted";
// Legacy single-mute key from before music/SFX were split.
const LEGACY_MUTE_KEY = "agent-hq:audio:muted";
const DEFAULT_MUSIC_VOLUME = 0.8;
const FADE_STEP_MS = 30;

/** SFX preloaded at startup so movement never misses its first cue. */
const ESSENTIAL_SFX: readonly SfxId[] = ["jump", "land", "footstep"];

function clampVolume(value: number): number {
  return value <= 0 ? 0 : value > 1 ? 1 : value;
}

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, muted: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (muted) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (private mode); mute still applies in memory.
  }
}

function loadPersistedMutes(): { music: boolean; sfx: boolean } {
  // One-time migration from the old combined mute key.
  const legacy = readStorage(LEGACY_MUTE_KEY) === "1";
  return {
    music: readStorage(MUSIC_MUTE_KEY) === "1" || legacy,
    sfx: readStorage(SFX_MUTE_KEY) === "1" || legacy,
  };
}

export class SoundController {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private musicElements = new Map<MusicId, HTMLAudioElement>();
  private desiredMusic: MusicId | null = null;
  private currentMusic: MusicId | null = null;
  private lastPlayed = new Map<SfxId, number>();
  private activeFades = new Set<number>();
  private initPromise: Promise<void> | null = null;
  private _musicMuted: boolean;
  private _sfxMuted: boolean;

  constructor() {
    const persisted = loadPersistedMutes();
    this._musicMuted = persisted.music;
    this._sfxMuted = persisted.sfx;
  }

  get musicMuted(): boolean {
    return this._musicMuted;
  }

  get sfxMuted(): boolean {
    return this._sfxMuted;
  }

  /**
   * Preload the essential movement SFX into AudioBuffers for low-latency
   * playback. Other SFX are fetched lazily on first playSfx call. Idempotent;
   * safe to call from multiple components. Music elements are created lazily
   * on first playMusic call.
   */
  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.loadEssentialBuffers();
    return this.initPromise;
  }

  /**
   * Must be called from a user gesture (click/key/touch) at least once. Resumes
   * the AudioContext and starts any queued soundtrack.
   */
  async unlock(): Promise<void> {
    this.ensureContext();
    if (this.ctx && this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        // Keep going; a later gesture retries.
      }
    }
    this.startDesiredMusic();
  }

  playSfx(id: SfxId, options: SfxOptions = {}): void {
    if (this.sfxMuted) return;
    const now = performance.now();
    const throttleMs = options.throttleMs ?? 0;
    if (throttleMs > 0) {
      const last = this.lastPlayed.get(id) ?? -Infinity;
      if (now - last < throttleMs) return;
    }
    const pool = SFX_FILES[id];
    if (pool.length === 0) return;
    if (!this.ctx) return;
    const file = pool[Math.floor(Math.random() * pool.length)];
    const buffer = this.buffers.get(file);
    if (buffer) {
      this.lastPlayed.set(id, now);
      this.playBuffer(buffer, options);
      return;
    }
    // First use: fetch and decode the picked file, then play it once ready.
    void this.ensureBuffer(file).then((loaded) => {
      if (!loaded || this.sfxMuted) return;
      const elapsed = performance.now() - (this.lastPlayed.get(id) ?? -Infinity);
      if (elapsed < throttleMs) return;
      this.lastPlayed.set(id, performance.now());
      this.playBuffer(loaded, options);
    });
  }

  /**
   * Start a looping ambience cue (water, etc.). The buffer is
   * fetched lazily on first use, so the returned handle takes effect once it
   * loads; stop()/setVolume() are safe to call before then. Respects the SFX
   * mute at creation time.
   */
  playLoop(id: SfxId, options: SfxOptions = {}): LoopHandle {
    let stopped = false;
    let source: AudioBufferSourceNode | null = null;
    let gain: GainNode | null = null;
    let target = clampVolume(options.volume ?? 0.8);
    const handle: LoopHandle = {
      stop: () => {
        stopped = true;
        if (source) {
          try {
            source.stop();
          } catch {
            // Already stopped.
          }
          source.disconnect();
        }
        if (gain) gain.disconnect();
        source = null;
        gain = null;
      },
      setVolume: (volume) => {
        target = clampVolume(volume);
        if (gain) gain.gain.value = target;
      },
    };
    const pool = SFX_FILES[id];
    if (pool.length === 0) return handle;
    if (!this.ctx || this.sfxMuted) return handle;
    const file = pool[Math.floor(Math.random() * pool.length)];
    void this.ensureBuffer(file).then((buffer) => {
      if (stopped || !buffer || !this.ctx || this.sfxMuted) return;
      source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      gain = this.ctx.createGain();
      gain.gain.value = target;
      source.connect(gain);
      gain.connect(this.ctx.destination);
      source.start();
    });
    return handle;
  }

  /** Start (or switch to) a looping soundtrack. Crossfades out of the old one. */
  playMusic(id: MusicId, options: MusicOptions = {}): void {
    if (!MUSIC_FILES[id]) return;
    this.desiredMusic = id;
    this.prepareMusicElement(id);
    if (this.musicMuted || !this.ctx || this.ctx.state !== "running") return;
    this.startMusic(id, options);
  }

  /** Stop the active soundtrack (used when entering a mini-game). */
  stopMusic(): void {
    this.desiredMusic = null;
    if (!this.currentMusic) return;
    const el = this.musicElements.get(this.currentMusic);
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    this.currentMusic = null;
  }

  setMusicMuted(muted: boolean): void {
    this._musicMuted = muted;
    writeStorage(MUSIC_MUTE_KEY, muted);
    for (const el of this.musicElements.values()) {
      if (muted) el.pause();
    }
    if (!muted) this.startDesiredMusic();
  }

  toggleMusicMute(): boolean {
    this.setMusicMuted(!this._musicMuted);
    return this._musicMuted;
  }

  setSfxMuted(muted: boolean): void {
    this._sfxMuted = muted;
    writeStorage(SFX_MUTE_KEY, muted);
  }

  toggleSfxMute(): boolean {
    this.setSfxMuted(!this._sfxMuted);
    return this._sfxMuted;
  }

  private ensureContext(): void {
    if (this.ctx) return;
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
  }

  private async loadEssentialBuffers(): Promise<void> {
    this.ensureContext();
    const files = new Set<string>();
    for (const id of ESSENTIAL_SFX) {
      for (const file of SFX_FILES[id]) files.add(file);
    }
    await Promise.all(
      [...files].map(async (file) => {
        const buffer = await this.fetchBuffer(file);
        if (buffer) this.buffers.set(file, buffer);
      }),
    );
  }

  private async ensureBuffer(file: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(file);
    if (cached) return cached;
    if (!this.ctx) return null;
    const buffer = await this.fetchBuffer(file);
    if (buffer) this.buffers.set(file, buffer);
    return buffer;
  }

  private async fetchBuffer(file: string): Promise<AudioBuffer | null> {
    try {
      const response = await fetch(`${SFX_DIR}/${file}`);
      if (!response.ok) return null;
      const data = await response.arrayBuffer();
      if (!this.ctx) return null;
      return await this.ctx.decodeAudioData(data);
    } catch {
      return null;
    }
  }

  private prepareMusicElement(id: MusicId): void {
    if (this.musicElements.has(id)) return;
    const el = new Audio(`${MUSIC_DIR}/${MUSIC_FILES[id]}`);
    el.loop = true;
    // Music is queued before a gesture, but downloading it immediately competes
    // with the scene's first visual and physics assets. Let play() fetch it when
    // the browser permits playback instead.
    el.preload = "none";
    this.musicElements.set(id, el);
  }

  private startMusic(id: MusicId, options: MusicOptions = {}): void {
    if (this.currentMusic === id) {
      const active = this.musicElements.get(id);
      if (active && active.paused && this.ctx?.state === "running") {
        void active.play().catch(() => undefined);
      }
      return;
    }
    const fadeMs = options.fadeMs ?? 500;
    const target = clampVolume(options.volume ?? DEFAULT_MUSIC_VOLUME);
    const previousId = this.currentMusic;
    const previous = previousId ? (this.musicElements.get(previousId) ?? null) : null;
    this.currentMusic = id;
    const el = this.musicElements.get(id);
    if (!el) return;
    el.volume = 0;
    el.currentTime = 0;
    void el
      .play()
      .then(() => {
        if (this.currentMusic !== id) {
          // Switched away while the element was loading; hand back to the new track.
          el.pause();
          return;
        }
        if (previous) {
          this.fadeMusic(previous, 0, fadeMs, () => {
            previous.pause();
            previous.currentTime = 0;
          });
        }
        this.fadeMusic(el, target, fadeMs);
      })
      .catch(() => {
        // Autoplay is blocked before the first user gesture. Keep the old track
        // and let unlock() retry the desired one.
        if (previous) this.currentMusic = previousId;
        else this.currentMusic = null;
      });
  }

  private startDesiredMusic(): void {
    if (this.musicMuted || !this.desiredMusic) return;
    const desired = this.desiredMusic;
    if (this.currentMusic !== desired) {
      this.startMusic(desired);
    } else {
      const el = this.musicElements.get(desired);
      if (el && el.paused) {
        void el.play().catch(() => undefined);
      }
    }
  }

  private playBuffer(buffer: AudioBuffer, options: SfxOptions): void {
    if (!this.ctx || this.sfxMuted) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = clampVolume(options.volume ?? 1);
    source.playbackRate.value = 1 + (options.pitch ?? 0);
    source.connect(gain);
    gain.connect(this.ctx.destination);
    source.start();
    source.addEventListener("ended", () => source.disconnect(), { once: true });
  }

  private fadeMusic(el: HTMLAudioElement, target: number, ms: number, onDone?: () => void): void {
    const start = el.volume;
    const startTime = performance.now();
    const interval = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - startTime) / Math.max(ms, 1));
      el.volume = start + (target - start) * t;
      if (t >= 1) {
        window.clearInterval(interval);
        this.activeFades.delete(interval);
        onDone?.();
      }
    }, FADE_STEP_MS);
    this.activeFades.add(interval);
  }
}

/** App-global instance shared by the world scene pages and the scene host. */
export const soundController = new SoundController();
