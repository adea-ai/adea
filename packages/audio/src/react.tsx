"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Music, Music2 } from "lucide-react";
import { soundController, type MusicOptions } from "./controller";
import { musicForScene } from "./scene-music";
import type { MusicId } from "./config";

export type SoundContextValue = {
  controller: typeof soundController;
  ready: boolean;
  musicMuted: boolean;
  toggleMusicMute: () => void;
  playMusic: (id: MusicId, options?: MusicOptions) => void;
};

const SoundContext = createContext<SoundContextValue | null>(null);

export function SoundProvider({ children }: { children: ReactNode }) {
  const [musicMuted, setMusicMuted] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) setMusicMuted(soundController.musicMuted);
    });

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
      toggleMusicMute: () => setMusicMuted(soundController.toggleMusicMute()),
      playMusic: (id, options) => soundController.playMusic(id, options),
    }),
    [musicMuted, ready],
  );

  return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>;
}

export function useSound(): SoundContextValue {
  const value = useContext(SoundContext);
  if (!value) throw new Error("useSound must be used within <SoundProvider>");
  return value;
}

export function useSceneMusic(sceneId: string | null | undefined): void {
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      soundController.playMusic(musicForScene(sceneId));
    }, 1500);
    return () => window.clearTimeout(timeout);
  }, [sceneId]);
}

function MusicButton({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={muted ? "Unmute music" : "Mute music"}
      aria-pressed={muted}
      onClick={onToggle}
      className={`inline-flex size-7 items-center justify-center rounded-full border border-input bg-background transition-colors ${muted ? "text-muted-foreground hover:text-foreground" : "bg-primary text-primary-foreground"}`}
    >
      {muted ? (
        <Music className="size-3.5" aria-hidden="true" />
      ) : (
        <Music2 className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

export function MusicToggle() {
  const { musicMuted, toggleMusicMute } = useSound();
  return <MusicButton muted={musicMuted} onToggle={toggleMusicMute} />;
}
