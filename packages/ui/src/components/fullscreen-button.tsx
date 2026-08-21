"use client";

import { useSyncExternalStore } from "react";
import { Maximize, Minimize } from "lucide-react";
import { soundController } from "@agent-hq/audio";
import { Button } from "#components/ui/button";
import { cn } from "#lib/utils";

/**
 * Toggles the browser Fullscreen API on the whole document. Positioned by the
 * caller (games and scenes pin it to the bottom-right corner); on mobile this
 * is the primary way to get the landscape full-bleed experience.
 *
 * iOS Safari has no element fullscreen, so when the API is unavailable the
 * button simply isn't rendered (a dead button is worse than none).
 */
export function FullscreenButton({ className }: { className?: string }) {
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const supported = useSyncExternalStore(
    () => () => undefined,
    () => {
      const element = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
      };
      return Boolean(
        document.fullscreenEnabled || element.requestFullscreen || element.webkitRequestFullscreen,
      );
    },
    () => false,
  );
  const isFullscreen = useSyncExternalStore(
    (onChange) => {
      document.addEventListener("fullscreenchange", onChange);
      return () => document.removeEventListener("fullscreenchange", onChange);
    },
    () => Boolean(document.fullscreenElement),
    () => false,
  );

  const toggle = () => {
    // Request fullscreen synchronously first: transient user activation is
    // consumed by any async work (e.g. the audio unlock) done beforehand.
    const element = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else if (element.requestFullscreen) {
      void element.requestFullscreen().catch(() => {
        // Fullscreen unexpectedly rejected: keep the control available for a retry.
      });
    } else if (element.webkitRequestFullscreen) {
      element.webkitRequestFullscreen();
    }
    soundController.playSfx("uiClick");
  };

  if (!mounted || !supported) return null;

  return (
    <div className={cn("pointer-events-none fixed z-40 flex flex-col items-end", className)}>
      <Button
        variant="outline"
        size="icon-lg"
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        aria-pressed={isFullscreen}
        onClick={toggle}
        className="pointer-events-auto border-white/25 bg-slate-950/60 text-white shadow-lg backdrop-blur-sm transition active:scale-95 [-webkit-touch-callout:none] [-webkit-user-select:none]"
      >
        {isFullscreen ? (
          <Minimize className="size-5" aria-hidden="true" />
        ) : (
          <Maximize className="size-5" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}
