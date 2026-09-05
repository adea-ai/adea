'use client'

import { createPortal } from 'react-dom'
import { useEffect, useState, type ReactNode } from 'react'
import { Box, Camera, Focus, Grid3X3, UserRoundPen } from 'lucide-react'
import { AccountDrawer } from './account-drawer'
import { Button } from '#components/ui/button'

export type SceneSettingsProps = {
  cameraViewMode: 'perspective' | 'orthographic'
  onCameraViewModeChange: (value: 'perspective' | 'orthographic') => void
  allowCameraViewModeChange?: boolean
  /** Standalone character selection and customization menu toggle. */
  characterDesignerEnabled?: boolean
  onCharacterDesignerChange?: (value: boolean) => void
  /** DOM target for the character designer control in an app shell toolbar. */
  characterDesignerTargetId?: string
  /** Open the scene-specific room layout and interior prop designer. */
  onOpenRoomDesigner?: () => void
  /** DOM target for the account drawer trigger in an app shell toolbar. */
  accountTargetId?: string
  accountLabel?: string
  accountAuthenticated?: boolean
  accountBusy?: boolean
  accountMusicControl?: ReactNode
  onAccountSignIn?: () => void
  onAccountSignOut?: () => void
  showAccountDrawer?: boolean
  /** DOM target for the compact camera controls in an app shell toolbar. */
  cameraTargetId?: string
  /** DOM target for the room designer control in an app shell toolbar. */
  roomDesignerTargetId?: string
  /** DOM target for the development scene editor control in an app shell toolbar. */
  sceneEditorTargetId?: string
  /** Development-only scene editor toggle, available in perspective view. */
  sceneEditorEnabled?: boolean
  onSceneEditorChange?: (value: boolean) => void
}

function usePortalTarget(targetId?: string) {
  const [target, setTarget] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setTarget(targetId ? document.getElementById(targetId) : null)
  }, [targetId])

  return target
}

function renderInTarget(content: ReactNode, target: HTMLElement | null) {
  return target ? createPortal(content, target) : content
}

/** Compact scene controls shared by the HQ shell and other scene hosts. */
export function SceneSettings({
  cameraViewMode,
  onCameraViewModeChange,
  allowCameraViewModeChange = true,
  characterDesignerEnabled,
  onCharacterDesignerChange,
  characterDesignerTargetId,
  onOpenRoomDesigner,
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
  const cameraTarget = usePortalTarget(cameraTargetId)
  const characterDesignerTarget = usePortalTarget(characterDesignerTargetId)
  const roomDesignerTarget = usePortalTarget(roomDesignerTargetId)
  const sceneEditorTarget = usePortalTarget(sceneEditorTargetId)

  const cameraControl = (
    <div className="workspace-camera-control" role="group" aria-label="Camera view">
      <Button
        type="button"
        size="sm"
        variant={cameraViewMode === 'perspective' ? 'default' : 'outline'}
        className="workspace-camera-button"
        aria-label="Perspective camera"
        title="Perspective camera"
        aria-pressed={cameraViewMode === 'perspective'}
        onClick={() => onCameraViewModeChange('perspective')}
      >
        <Camera aria-hidden="true" />
        Perspective
      </Button>
      <Button
        type="button"
        size="sm"
        variant={cameraViewMode === 'orthographic' ? 'default' : 'outline'}
        className="workspace-camera-button"
        aria-label="Top-down camera"
        title="Top-down camera"
        aria-pressed={cameraViewMode === 'orthographic'}
        onClick={() => onCameraViewModeChange('orthographic')}
      >
        <Focus aria-hidden="true" />
        Top-down
      </Button>
    </div>
  )

  const characterDesignerControl = (
    <Button
      type="button"
      variant={characterDesignerEnabled ? 'default' : 'outline'}
      size="sm"
      aria-haspopup="dialog"
      aria-label={characterDesignerEnabled ? 'Close character designer' : 'Open character designer'}
      title={characterDesignerEnabled ? 'Close character designer' : 'Open character designer'}
      aria-pressed={characterDesignerEnabled}
      onClick={() => onCharacterDesignerChange?.(!characterDesignerEnabled)}
    >
      <UserRoundPen className="size-4" aria-hidden="true" />
      <span className="workspace-character-designer-label">Character</span>
    </Button>
  )

  const roomDesignerControl = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-haspopup="dialog"
      aria-label="Open room designer"
      title="Open room designer"
      onClick={onOpenRoomDesigner}
    >
      <Grid3X3 className="size-4" aria-hidden="true" />
      <span className="workspace-room-designer-label">Room designer</span>
    </Button>
  )

  const sceneEditorControl = (
    <Button
      type="button"
      variant={sceneEditorEnabled ? 'default' : 'outline'}
      size="sm"
      aria-haspopup="dialog"
      aria-label={sceneEditorEnabled ? 'Close scene editor' : 'Open scene editor'}
      title={sceneEditorEnabled ? 'Close scene editor' : 'Open scene editor'}
      aria-pressed={sceneEditorEnabled}
      onClick={() => onSceneEditorChange?.(!sceneEditorEnabled)}
    >
      <Box className="size-4" aria-hidden="true" />
      <span className="workspace-scene-editor-label">Scene editor</span>
    </Button>
  )

  return (
    <>
      {showAccountDrawer ? (
        <AccountDrawer
          accountLabel={accountLabel}
          authenticated={accountAuthenticated}
          busy={accountBusy}
          musicControl={accountMusicControl}
          triggerTargetId={accountTargetId}
          onSignIn={onAccountSignIn}
          onSignOut={onAccountSignOut}
        />
      ) : null}
      {allowCameraViewModeChange ? renderInTarget(cameraControl, cameraTarget) : null}
      {characterDesignerEnabled != null &&
      !characterDesignerEnabled &&
      onCharacterDesignerChange ? (
        characterDesignerTarget ? (
          createPortal(characterDesignerControl, characterDesignerTarget)
        ) : (
          <div className="fixed right-4 top-16 z-40">{characterDesignerControl}</div>
        )
      ) : null}
      {onOpenRoomDesigner && cameraViewMode === 'orthographic' ? (
        roomDesignerTarget ? (
          createPortal(roomDesignerControl, roomDesignerTarget)
        ) : (
          <div className="fixed right-4 top-16 z-40">{roomDesignerControl}</div>
        )
      ) : null}
      {sceneEditorEnabled != null &&
      !sceneEditorEnabled &&
      onSceneEditorChange &&
      cameraViewMode === 'perspective' ? (
        sceneEditorTarget ? (
          createPortal(sceneEditorControl, sceneEditorTarget)
        ) : (
          <div className="fixed right-4 top-16 z-40">{sceneEditorControl}</div>
        )
      ) : null}
    </>
  )
}
