"use client";

import { createPortal } from "react-dom";
import { useEffect, useState, type ReactNode } from "react";
import { Camera, Grid3X3, UserRound } from "lucide-react";
import type { CharacterOption } from "./character-selector";
import { Button } from "#components/ui/button";

export type SceneSettingsProps = {
  characterOptions: readonly CharacterOption[];
  character: string;
  onCharacterChange: (character: string) => void;
  cameraViewMode: "perspective" | "orthographic";
  onCameraViewModeChange: (value: "perspective" | "orthographic") => void;
  allowCameraViewModeChange?: boolean;
  /** Top-down room layout and interior prop designer toggle. */
  roomDesignerEnabled?: boolean;
  onRoomDesignerChange?: (value: boolean) => void;
  /** DOM target for the compact character picker in an app shell toolbar. */
  characterTargetId?: string;
  /** DOM target for the compact camera controls in an app shell toolbar. */
  cameraTargetId?: string;
  /** DOM target for the room designer control in an app shell toolbar. */
  roomDesignerTargetId?: string;
};

function usePortalTarget(targetId?: string) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(targetId ? document.getElementById(targetId) : null);
  }, [targetId]);

  return target;
}

function renderInTarget(content: ReactNode, target: HTMLElement | null) {
  return target ? createPortal(content, target) : content;
}

/** Compact scene controls shared by the HQ shell and other scene hosts. */
export function SceneSettings({
  characterOptions,
  character,
  onCharacterChange,
  cameraViewMode,
  onCameraViewModeChange,
  allowCameraViewModeChange = true,
  roomDesignerEnabled,
  onRoomDesignerChange,
  characterTargetId,
  cameraTargetId,
  roomDesignerTargetId,
}: SceneSettingsProps) {
  const characterTarget = usePortalTarget(characterTargetId);
  const cameraTarget = usePortalTarget(cameraTargetId);
  const roomDesignerTarget = usePortalTarget(roomDesignerTargetId);

  const characterControl = (
    <label className="workspace-character-control" title="Character">
      <UserRound className="workspace-character-icon" aria-hidden="true" />
      <span className="sr-only">Character</span>
      <select
        aria-label="Character"
        className="workspace-character-select"
        value={character}
        onChange={(event) => onCharacterChange(event.target.value)}
      >
        {characterOptions.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );

  const cameraControl = (
    <div className="workspace-camera-control" role="group" aria-label="Camera view">
      <Button
        type="button"
        size="sm"
        variant={cameraViewMode === "perspective" ? "default" : "outline"}
        className="workspace-camera-button"
        aria-label="Perspective camera"
        title="Perspective camera"
        aria-pressed={cameraViewMode === "perspective"}
        onClick={() => onCameraViewModeChange("perspective")}
      >
        <Camera aria-hidden="true" />
        <span className="sr-only">Perspective</span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant={cameraViewMode === "orthographic" ? "default" : "outline"}
        className="workspace-camera-button"
        aria-label="Top-down camera"
        title="Top-down camera"
        aria-pressed={cameraViewMode === "orthographic"}
        onClick={() => onCameraViewModeChange("orthographic")}
      >
        <Grid3X3 aria-hidden="true" />
        <span className="sr-only">Top-down</span>
      </Button>
    </div>
  );

  const roomDesignerControl = (
    <Button
      type="button"
      variant={roomDesignerEnabled ? "default" : "outline"}
      size="icon-sm"
      aria-label={roomDesignerEnabled ? "Close room designer" : "Open room designer"}
      title={roomDesignerEnabled ? "Close room designer" : "Open room designer"}
      aria-pressed={roomDesignerEnabled}
      onClick={() => onRoomDesignerChange?.(!roomDesignerEnabled)}
    >
      <Grid3X3 aria-hidden="true" />
      <span className="sr-only">Room designer</span>
    </Button>
  );

  return (
    <>
      {renderInTarget(characterControl, characterTarget)}
      {allowCameraViewModeChange ? renderInTarget(cameraControl, cameraTarget) : null}
      {roomDesignerEnabled != null && onRoomDesignerChange && cameraViewMode === "orthographic" ? (
        roomDesignerTarget ? (
          createPortal(roomDesignerControl, roomDesignerTarget)
        ) : (
          <div className="fixed right-4 top-16 z-40">{roomDesignerControl}</div>
        )
      ) : null}
    </>
  );
}
