"use client";

import { createPortal } from "react-dom";
import { useEffect, useState, type ReactNode } from "react";
import { Box, Camera, Focus, Grid3X3 } from "lucide-react";
import type { CharacterConfiguration, CharacterPartOption } from "@agent-hq/characters";
import type { CharacterOption } from "./character-selector";
import { AccountDrawer } from "./account-drawer";
import { Button } from "#components/ui/button";

export type SceneSettingsProps = {
  characterOptions: readonly CharacterOption[];
  character: string;
  onCharacterChange: (character: string) => void;
  characterConfiguration?: CharacterConfiguration;
  onCharacterConfigurationChange?: (configuration: CharacterConfiguration) => void;
  characterPartOptions?: readonly CharacterPartOption[];
  cameraViewMode: "perspective" | "orthographic";
  onCameraViewModeChange: (value: "perspective" | "orthographic") => void;
  allowCameraViewModeChange?: boolean;
  /** Top-down room layout and interior prop designer toggle. */
  roomDesignerEnabled?: boolean;
  onRoomDesignerChange?: (value: boolean) => void;
  /** DOM target for the account drawer trigger in an app shell toolbar. */
  accountTargetId?: string;
  accountLabel?: string;
  accountAuthenticated?: boolean;
  accountBusy?: boolean;
  accountMusicControl?: ReactNode;
  onAccountSignIn?: () => void;
  onAccountSignOut?: () => void;
  showAccountDrawer?: boolean;
  /** DOM target for the compact camera controls in an app shell toolbar. */
  cameraTargetId?: string;
  /** DOM target for the room designer control in an app shell toolbar. */
  roomDesignerTargetId?: string;
  /** DOM target for the development scene editor control in an app shell toolbar. */
  sceneEditorTargetId?: string;
  /** Development-only scene editor toggle, available in perspective view. */
  sceneEditorEnabled?: boolean;
  onSceneEditorChange?: (value: boolean) => void;
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
  characterConfiguration,
  onCharacterConfigurationChange,
  characterPartOptions,
  cameraViewMode,
  onCameraViewModeChange,
  allowCameraViewModeChange = true,
  roomDesignerEnabled,
  onRoomDesignerChange,
  accountTargetId,
  accountLabel,
  accountAuthenticated,
  accountBusy,
  accountMusicControl,
  onAccountSignIn,
  onAccountSignOut,
  showAccountDrawer = true,
  cameraTargetId,
  roomDesignerTargetId,
  sceneEditorTargetId,
  sceneEditorEnabled,
  onSceneEditorChange,
}: SceneSettingsProps) {
  const cameraTarget = usePortalTarget(cameraTargetId);
  const roomDesignerTarget = usePortalTarget(roomDesignerTargetId);
  const sceneEditorTarget = usePortalTarget(sceneEditorTargetId);

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
        Perspective
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
        <Focus aria-hidden="true" />
        Top-down
      </Button>
    </div>
  );

  const roomDesignerControl = (
    <Button
      type="button"
      variant={roomDesignerEnabled ? "default" : "outline"}
      size="sm"
      aria-haspopup="dialog"
      aria-label={roomDesignerEnabled ? "Close room designer" : "Open room designer"}
      title={roomDesignerEnabled ? "Close room designer" : "Open room designer"}
      aria-pressed={roomDesignerEnabled}
      onClick={() => onRoomDesignerChange?.(!roomDesignerEnabled)}
    >
      <Grid3X3 className="size-4" aria-hidden="true" />
      <span className="workspace-room-designer-label">Room designer</span>
    </Button>
  );

  const sceneEditorControl = (
    <Button
      type="button"
      variant={sceneEditorEnabled ? "default" : "outline"}
      size="sm"
      aria-haspopup="dialog"
      aria-label={sceneEditorEnabled ? "Close scene editor" : "Open scene editor"}
      title={sceneEditorEnabled ? "Close scene editor" : "Open scene editor"}
      aria-pressed={sceneEditorEnabled}
      onClick={() => onSceneEditorChange?.(!sceneEditorEnabled)}
    >
      <Box className="size-4" aria-hidden="true" />
      <span className="workspace-scene-editor-label">Scene editor</span>
    </Button>
  );

  return (
    <>
      {showAccountDrawer ? (
        <AccountDrawer
          accountLabel={accountLabel}
          authenticated={accountAuthenticated}
          busy={accountBusy}
          musicControl={accountMusicControl}
          characterOptions={characterOptions}
          character={character}
          onCharacterChange={onCharacterChange}
          characterConfiguration={characterConfiguration}
          onCharacterConfigurationChange={onCharacterConfigurationChange}
          characterPartOptions={characterPartOptions}
          triggerTargetId={accountTargetId}
          onSignIn={onAccountSignIn}
          onSignOut={onAccountSignOut}
        />
      ) : null}
      {allowCameraViewModeChange ? renderInTarget(cameraControl, cameraTarget) : null}
      {roomDesignerEnabled != null &&
      !roomDesignerEnabled &&
      onRoomDesignerChange &&
      cameraViewMode === "orthographic" ? (
        roomDesignerTarget ? (
          createPortal(roomDesignerControl, roomDesignerTarget)
        ) : (
          <div className="fixed right-4 top-16 z-40">{roomDesignerControl}</div>
        )
      ) : null}
      {sceneEditorEnabled != null &&
      !sceneEditorEnabled &&
      onSceneEditorChange &&
      cameraViewMode === "perspective" ? (
        sceneEditorTarget ? (
          createPortal(sceneEditorControl, sceneEditorTarget)
        ) : (
          <div className="fixed right-4 top-16 z-40">{sceneEditorControl}</div>
        )
      ) : null}
    </>
  );
}
