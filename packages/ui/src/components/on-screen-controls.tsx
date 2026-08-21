"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import { cn } from "#lib/utils";
type ControlButtonProps = {
  code: string;
  label: string;
  children: ReactNode;
  className?: string;
};

function sendKeyEvent(type: "keydown" | "keyup", code: string): void {
  window.dispatchEvent(
    new KeyboardEvent(type, { bubbles: true, cancelable: true, code, key: code }),
  );
}

function ControlButton({ code, label, children, className }: ControlButtonProps) {
  const pressed = useRef(false);
  const pressedPointer = useRef<number | null>(null);

  const release = useCallback(() => {
    if (!pressed.current) return;
    pressed.current = false;
    pressedPointer.current = null;
    sendKeyEvent("keyup", code);
  }, [code]);

  // Self-heal: release the key if the pointerup lands elsewhere (e.g. the
  // scene DOM changes mid-teleport) or the window loses focus. PointerId
  // matching preserves multi-touch.
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
      event.currentTarget.setPointerCapture(event.pointerId);
      sendKeyEvent("keydown", code);
    },
    [code],
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

function ActionButton({
  code,
  label,
  children,
}: {
  code: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <ControlButton code={code} label={label} className="text-xs font-semibold">
      {children}
    </ControlButton>
  );
}

export function OnScreenControls() {
  const [jetpackActive, setJetpackActive] = useState(false);

  useEffect(() => {
    const onVehicleChange = (event: Event) => {
      const detail = (event as CustomEvent<{ activeVehicle: string | null }>).detail;
      setJetpackActive(detail?.activeVehicle === "jetpack");
    };
    window.addEventListener("agent-hq:vehicle-change", onVehicleChange);
    return () => window.removeEventListener("agent-hq:vehicle-change", onVehicleChange);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-30 flex select-none items-end justify-between gap-4 pb-[env(safe-area-inset-bottom)] sm:inset-x-6 sm:bottom-6 [-webkit-touch-callout:none] [-webkit-user-select:none]">
      <div className="pointer-events-auto grid grid-cols-3 gap-1.5 rounded-3xl bg-slate-950/20 p-2 backdrop-blur-[2px]">
        <span />
        <ControlButton code="KeyW" label="Move forward" className="size-12 rounded-xl text-xl">
          ▲
        </ControlButton>
        <span />
        <ControlButton code="KeyA" label="Move left" className="size-12 rounded-xl text-xl">
          ◀
        </ControlButton>
        <ControlButton code="KeyS" label="Move backward" className="size-12 rounded-xl text-xl">
          ▼
        </ControlButton>
        <ControlButton code="KeyD" label="Move right" className="size-12 rounded-xl text-xl">
          ▶
        </ControlButton>
      </div>
      <div className="pointer-events-auto flex flex-col items-end gap-2">
        <div className="flex justify-end gap-2">
          <ActionButton code="Space" label="Jump">
            JUMP
          </ActionButton>
          <ActionButton code="KeyV" label="Toggle hoverboard">
            BOARD
          </ActionButton>
          <ActionButton code="KeyG" label="Toggle jetpack">
            PACK
          </ActionButton>
        </div>
        {jetpackActive ? (
          <div className="flex justify-end gap-2" data-testid="jetpack-controls">
            <ControlButton
              code="ShiftLeft"
              label="Jetpack ascend"
              className="text-xs font-semibold"
            >
              UP
            </ControlButton>
            <ControlButton
              code="ControlLeft"
              label="Jetpack descend"
              className="text-xs font-semibold"
            >
              DOWN
            </ControlButton>
            <ControlButton code="KeyB" label="Leave vehicle" className="text-xs font-semibold">
              EXIT
            </ControlButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}
