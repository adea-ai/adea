// Mini-game audio adapter: the mini-games (@agent-hq/game-*) used to roll their own
// AudioManager (per-game SFX file lists + music elements). This thin adapter
// gives them the same call surface (load/unlock/playSound/update/stopMusic/
// playMusic) while playing through the shared @agent-hq/audio sound controller, so
// every game reuses the centrally-hosted SFX/music files and the world's mute
// settings instead of duplicating them.

import { soundController } from "./controller";
import type { MusicId, SfxId } from "./config";

export type MiniGameAudioConfig = {
  /** Map the game's logical sound id -> shared @agent-hq/audio SFX id. */
  sfx: Record<string, SfxId>;
  /** Music tracks by index, for games that addressed tracks by index. */
  music?: MusicId[];
};

/** Drop-in replacement for the old per-game AudioManager. */
export class MiniGameAudio {
  constructor(private readonly config: MiniGameAudioConfig) {}

  /** Preload the essential movement SFX; resolves when they're ready. */
  load(): Promise<void> {
    return soundController.init();
  }

  /** Resume the AudioContext from a user gesture. */
  unlock(): Promise<void> {
    return soundController.unlock();
  }

  /** Play a sound effect, mapping the game's id to a shared SFX id. */
  playSound(id: string, volume = 1, pitch = 0): void {
    const sfx = this.config.sfx[id];
    if (!sfx) return;
    soundController.playSfx(sfx, { volume, pitch });
  }

  /** No-op: the shared controller handles its own throttle bookkeeping. */
  update(_dt: number): void {
    // Intentionally empty.
  }

  /** Start the music track at the given index (if the game uses indexed tracks). */
  playMusic(index: number, _ignoreMute = false): void {
    const track = this.config.music?.[index];
    if (track) soundController.playMusic(track);
  }

  /** Stop the active soundtrack. */
  stopMusic(): void {
    soundController.stopMusic();
  }
}
