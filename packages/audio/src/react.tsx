// React bindings for the global sound controller: a SoundProvider that unlocks
// audio on the first user gesture, hooks for per-scene soundtracks, and
// separate music/SFX mute toggles for the settings drawer.

"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Music, Music2, Volume2, VolumeX } from "lucide-react";
import { soundController, type MusicOptions, type SfxOptions } from "./controller";
import { musicForScene } from "./scene-music";
import type { MusicId, SfxId } from "./config";

export type SoundContextValue = {
  /** The shared controller instance. */
  controller: typeof soundController;
  /** True once the browser audio context has been unlocked by a gesture. */
  ready: boolean;
  musicMuted: boolean;
  sfxMuted: boolean;
  toggleMusicMute: () => void;
  toggleSfxMute: () => void;
  playSfx: (id: SfxId, options?: SfxOptions) => void;
  playMusic: (id: MusicId, options?: MusicOptions) => void;
};

const SoundContext = createContext<SoundContextValue | null>(null);

export function SoundProvider({ children }: { children: ReactNode }) {
  // The controller restores mute preferences from localStorage at module
  // load. Keep the first render deterministic for SSR and hydrate those
  // preferences in the effect below instead of reading browser state during
  // render.
  const [musicMuted, setMusicMuted] = useState(false);
  const [sfxMuted, setSfxMuted] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      setMusicMuted(soundController.musicMuted);
      setSfxMuted(soundController.sfxMuted);
    });
    // Browsers block audio until a user gesture; unlock (resume the context and
    // start any queued soundtrack) on the first one.
    const onGesture = () => {
      void soundController.unlock().then(() => {
        if (mounted) setReady(true);
      });
    };
    window.addEventListener("pointerdown", onGesture, { capture: true });
    window.addEventListener("keydown", onGesture, { capture: true });
    window.addEventListener("touchstart", onGesture, { capture: true });
    if (new URLSearchParams(window.location.search).has("debug")) {
      (window as unknown as { __agentHqSound?: typeof soundController }).__agentHqSound =
        soundController;
    }
    return () => {
      mounted = false;
      window.removeEventListener("pointerdown", onGesture, { capture: true });
      window.removeEventListener("keydown", onGesture, { capture: true });
      window.removeEventListener("touchstart", onGesture, { capture: true });
    };
  }, []);

  const value = useMemo<SoundContextValue>(
    () => ({
      controller: soundController,
      ready,
      musicMuted,
      sfxMuted,
      toggleMusicMute: () => setMusicMuted(soundController.toggleMusicMute()),
      toggleSfxMute: () => setSfxMuted(soundController.toggleSfxMute()),
      playSfx: (id, options) => soundController.playSfx(id, options),
      playMusic: (id, options) => soundController.playMusic(id, options),
    }),
    [musicMuted, sfxMuted, ready],
  );

  return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>;
}

export function useSound(): SoundContextValue {
  const value = useContext(SoundContext);
  if (!value) throw new Error("useSound must be used within <SoundProvider>");
  return value;
}

/**
 * Plays the soundtrack assigned to a scene while the component is mounted.
 * Pass the scene manifest id (e.g. "isla-azul"); any unmapped id uses the main
 * theme.
 */
export function useSceneMusic(sceneId: string | null | undefined): void {
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      soundController.playMusic(musicForScene(sceneId));
    }, 1500);
    return () => window.clearTimeout(timeout);
  }, [sceneId]);
}

/** Stops any scene soundtrack (used when entering a mini-game with its own audio). */
export function useStopMusic(): void {
  useEffect(() => {
    soundController.stopMusic();
  }, []);
}

function joinClassNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type ToggleProps = {
  muted: boolean;
  onToggle: () => void;
  /** Accessible label while audio is playing. */
  onLabel: string;
  /** Accessible label while muted. */
  offLabel: string;
  mutedIcon: ReactNode;
  activeIcon: ReactNode;
};

/** Compact circular toggle shared by the music and SFX buttons. */
function MuteButton({ muted, onToggle, onLabel, offLabel, mutedIcon, activeIcon }: ToggleProps) {
  return (
    <button
      type="button"
      aria-label={muted ? offLabel : onLabel}
      aria-pressed={muted}
      onClick={() => {
        soundController.playSfx("uiClick");
        onToggle();
      }}
      className={joinClassNames(
        "inline-flex size-8 items-center justify-center rounded-full border border-input bg-background transition-colors",
        muted
          ? "text-muted-foreground hover:text-foreground"
          : "bg-primary text-primary-foreground",
      )}
    >
      {muted ? mutedIcon : activeIcon}
    </button>
  );
}

/** Music on/off toggle for the settings drawer. */
export function MusicToggle() {
  const { musicMuted, toggleMusicMute } = useSound();
  return (
    <MuteButton
      muted={musicMuted}
      onToggle={toggleMusicMute}
      onLabel="Mute music"
      offLabel="Unmute music"
      mutedIcon={<Music className="size-4" aria-hidden="true" />}
      activeIcon={<Music2 className="size-4" aria-hidden="true" />}
    />
  );
}

/** Sound-effects on/off toggle for the settings drawer. */
export function SfxToggle() {
  const { sfxMuted, toggleSfxMute } = useSound();
  return (
    <MuteButton
      muted={sfxMuted}
      onToggle={toggleSfxMute}
      onLabel="Mute sound effects"
      offLabel="Unmute sound effects"
      mutedIcon={<VolumeX className="size-4" aria-hidden="true" />}
      activeIcon={<Volume2 className="size-4" aria-hidden="true" />}
    />
  );
}
