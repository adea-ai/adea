"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
  GameTouchControls,
  type GameTouchAction,
  type GameTouchLayout,
} from "./game-touch-controls";
import { cn } from "../lib/utils";

export type GameShellProps = {
  mountGame: (container: HTMLElement) => () => void;
  actions: readonly GameTouchAction[];
  layout?: GameTouchLayout;
  bgClass?: string;
  children?: ReactNode;
};

/** Shared full-viewport shell for browser mini-games. */
export function GameShell({
  mountGame,
  actions,
  layout = "pad",
  bgClass = "fixed inset-0 bg-[#101420]",
  children,
}: GameShellProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef(mountGame);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return mountRef.current(container);
  }, []);

  return (
    <div
      className={cn(
        "fixed inset-0 select-none [-webkit-touch-callout:none] [-webkit-user-select:none]",
        bgClass,
      )}
    >
      <div ref={containerRef} className="relative h-full w-full" />
      {children}
      <GameTouchControls actions={actions} layout={layout} />
    </div>
  );
}
