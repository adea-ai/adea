"use client";

import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent, ReactNode } from "react";
import { cn } from "#lib/utils";

export type GameTouchAction = {
  /** KeyboardEvent.code to emit (e.g. "Space", "KeyX"). */
  code: string;
  /** KeyboardEvent.key to emit; defaults to a lowercased code (space -> " "). */
  key?: string;
  /** Accessible label shown on the button. */
  label: string;
  /** Optional sprite icon (like the scene-view control buttons). */
  icon?: string;
  /** Optional custom content instead of the label/icon. */
  children?: ReactNode;
};

export type GameTouchLayout = "pad" | "side";

function sendKeyEvent(type: "keydown" | "keyup", code: string, key: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, code, key }));
}

/** Key emitted for a given KeyboardEvent.code (space and letters only). */
function defaultKey(code: string): string {
  if (code === "Space") return " ";
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  return code.toLowerCase();
}

type TouchButtonProps = {
  code: string;
  keyCode: string;
  label: string;
  children: ReactNode;
  className?: string;
};

function TouchButton({ code, keyCode, label, children, className }: TouchButtonProps) {
  const pressed = useRef(false);
  const pressedPointer = useRef<number | null>(null);

  const release = useCallback(() => {
    if (!pressed.current) return;
    pressed.current = false;
    pressedPointer.current = null;
    sendKeyEvent("keyup", code, keyCode);
  }, [code, keyCode]);

  // Self-heal: if the pointerup lands somewhere else (e.g. the scene DOM
  // changes mid-teleport) or the window loses focus, release the key so a
  // control never gets stuck. PointerId matching preserves multi-touch
  // (holding a d-pad arrow while tapping an action button).
  useEffect(() => {
    const onWindowPointerUp = (event: globalThis.PointerEvent) => {
      if (pressedPointer.current === event.pointerId) release();
    };
    const onBlur = () => release();
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [release]);

  const press = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (pressed.current) return;
      pressed.current = true;
      pressedPointer.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is unavailable for synthetic events; the press still
        // fires via the pointerup/leave handlers.
      }
      sendKeyEvent("keydown", code, keyCode);
    },
    [code, keyCode],
  );

  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "flex size-14 touch-none select-none items-center justify-center rounded-2xl border border-white/25 bg-slate-950/65 p-2 text-white shadow-lg backdrop-blur-sm transition active:scale-95 [-webkit-touch-callout:none] [-webkit-user-select:none]",
        className,
      )}
      onContextMenu={(event) => event.preventDefault()}
      onPointerCancel={release}
      onPointerDown={press}
      onPointerLeave={release}
      onPointerUp={release}
    >
      {children}
    </button>
  );
}

function ActionButton({ action }: { action: GameTouchAction }) {
  return (
    <TouchButton
      code={action.code}
      keyCode={action.key ?? defaultKey(action.code)}
      label={action.label}
      className="size-16 min-w-16 px-3"
    >
      {action.children ?? (
        <>
          {action.icon ? (
            <img
              src={action.icon}
              alt=""
              draggable={false}
              className="size-full select-none object-contain [-webkit-touch-callout:none] [-webkit-user-select:none]"
            />
          ) : (
            <span className="text-sm font-semibold">{action.label}</span>
          )}
        </>
      )}
    </TouchButton>
  );
}

/**
 * Generic touch controls for the canvas mini-games: a movement pad on the left
 * (4-way `pad`, or side-arrows-only `side` for platformers) and action buttons
 * on the right. Each press dispatches the matching keyboard event on window,
 * which the @agent-hq/game-runtime KeyboardInput already listens to, so every game
 * becomes touch-playable with zero per-game input code.
 */
export function GameTouchControls({
  actions,
  layout = "pad",
}: {
  actions: readonly GameTouchAction[];
  layout?: GameTouchLayout;
}) {
  const centered = actions.length === 0;
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-4 bottom-4 z-30 flex select-none items-end gap-4 pb-[env(safe-area-inset-bottom)] [-webkit-touch-callout:none] [-webkit-user-select:none]",
        centered ? "justify-center" : "justify-between",
      )}
    >
      {layout === "side" ? (
        <div className="pointer-events-auto grid grid-cols-2 gap-3 rounded-3xl bg-slate-950/20 p-2 backdrop-blur-[2px]">
          <TouchButton
            code="ArrowLeft"
            keyCode="arrowleft"
            label="Move left"
            className="size-14 rounded-xl text-2xl"
          >
            ◀
          </TouchButton>
          <TouchButton
            code="ArrowRight"
            keyCode="arrowright"
            label="Move right"
            className="size-14 rounded-xl text-2xl"
          >
            ▶
          </TouchButton>
        </div>
      ) : (
        <div className="pointer-events-auto grid grid-cols-3 gap-1.5 rounded-3xl bg-slate-950/20 p-2 backdrop-blur-[2px]">
          <span />
          <TouchButton
            code="ArrowUp"
            keyCode="arrowup"
            label="Move up"
            className="size-14 rounded-xl text-2xl"
          >
            ▲
          </TouchButton>
          <span />
          <TouchButton
            code="ArrowLeft"
            keyCode="arrowleft"
            label="Move left"
            className="size-14 rounded-xl text-2xl"
          >
            ◀
          </TouchButton>
          <TouchButton
            code="ArrowDown"
            keyCode="arrowdown"
            label="Move down"
            className="size-14 rounded-xl text-2xl"
          >
            ▼
          </TouchButton>
          <TouchButton
            code="ArrowRight"
            keyCode="arrowright"
            label="Move right"
            className="size-14 rounded-xl text-2xl"
          >
            ▶
          </TouchButton>
        </div>
      )}
      {actions.length > 0 ? (
        <div className="pointer-events-auto flex justify-end gap-2">
          {actions.map((action) => (
            <ActionButton key={action.code} action={action} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
