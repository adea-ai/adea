import { Box, Camera, Focus, Grid3X3, UserRoundPen } from 'lucide-solid'
import { createEffect, createSignal, Show, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'

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
  accountMusicControl?: JSX.Element
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

function usePortalTarget(targetId: () => string | undefined) {
  const [target, setTarget] = createSignal<HTMLElement | null>(null)

  createEffect(() => {
    const id = targetId()
    setTarget(id ? document.getElementById(id) : null)
  })

  return target
}

function renderInTarget(content: JSX.Element, target: HTMLElement | null) {
  return target ? <Portal mount={target}>{content}</Portal> : content
}

/** Compact scene controls shared by the HQ shell and other scene hosts. */
export function SceneSettings(props: SceneSettingsProps) {
  const cameraTarget = usePortalTarget(() => props.cameraTargetId)
  const characterDesignerTarget = usePortalTarget(() => props.characterDesignerTargetId)
  const roomDesignerTarget = usePortalTarget(() => props.roomDesignerTargetId)
  const sceneEditorTarget = usePortalTarget(() => props.sceneEditorTargetId)

  const cameraControl = (
    <div class="workspace-camera-control" role="group" aria-label="Camera view">
      <Button
        type="button"
        size="sm"
        variant={props.cameraViewMode === 'perspective' ? 'default' : 'outline'}
        class="workspace-camera-button"
        aria-label="Perspective camera"
        title="Perspective camera"
        aria-pressed={props.cameraViewMode === 'perspective'}
        onClick={() => props.onCameraViewModeChange('perspective')}
      >
        <Camera aria-hidden="true" />
        Perspective
      </Button>
      <Button
        type="button"
        size="sm"
        variant={props.cameraViewMode === 'orthographic' ? 'default' : 'outline'}
        class="workspace-camera-button"
        aria-label="Top-down camera"
        title="Top-down camera"
        aria-pressed={props.cameraViewMode === 'orthographic'}
        onClick={() => props.onCameraViewModeChange('orthographic')}
      >
        <Focus aria-hidden="true" />
        Top-down
      </Button>
    </div>
  )

  const characterDesignerControl = (
    <Button
      type="button"
      variant={props.characterDesignerEnabled ? 'default' : 'outline'}
      size="sm"
      aria-haspopup="dialog"
      aria-label={
        props.characterDesignerEnabled ? 'Close character designer' : 'Open character designer'
      }
      title={
        props.characterDesignerEnabled ? 'Close character designer' : 'Open character designer'
      }
      aria-pressed={props.characterDesignerEnabled}
      onClick={() => props.onCharacterDesignerChange?.(!props.characterDesignerEnabled)}
    >
      <UserRoundPen class="size-4" aria-hidden="true" />
      <span class="workspace-character-designer-label">Character</span>
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
      onClick={() => props.onOpenRoomDesigner?.()}
    >
      <Grid3X3 class="size-4" aria-hidden="true" />
      <span class="workspace-room-designer-label">Room designer</span>
    </Button>
  )

  const sceneEditorControl = (
    <Button
      type="button"
      variant={props.sceneEditorEnabled ? 'default' : 'outline'}
      size="sm"
      aria-haspopup="dialog"
      aria-label={props.sceneEditorEnabled ? 'Close scene editor' : 'Open scene editor'}
      title={props.sceneEditorEnabled ? 'Close scene editor' : 'Open scene editor'}
      aria-pressed={props.sceneEditorEnabled}
      onClick={() => props.onSceneEditorChange?.(!props.sceneEditorEnabled)}
    >
      <Box class="size-4" aria-hidden="true" />
      <span class="workspace-scene-editor-label">Scene editor</span>
    </Button>
  )

  const showCharacterDesignerControl = () =>
    props.characterDesignerEnabled != null &&
    !props.characterDesignerEnabled &&
    Boolean(props.onCharacterDesignerChange)

  const showRoomDesignerControl = () =>
    Boolean(props.onOpenRoomDesigner) && props.cameraViewMode === 'orthographic'

  const showSceneEditorControl = () =>
    props.sceneEditorEnabled != null &&
    !props.sceneEditorEnabled &&
    Boolean(props.onSceneEditorChange) &&
    props.cameraViewMode === 'perspective'

  return (
    <>
      <Show when={props.showAccountDrawer ?? true}>
        <AccountDrawer
          accountLabel={props.accountLabel}
          authenticated={props.accountAuthenticated}
          busy={props.accountBusy}
          musicControl={props.accountMusicControl}
          triggerTargetId={props.accountTargetId}
          onSignIn={props.onAccountSignIn}
          onSignOut={props.onAccountSignOut}
        />
      </Show>
      <Show when={props.allowCameraViewModeChange ?? true}>
        {renderInTarget(cameraControl, cameraTarget())}
      </Show>
      <Show when={showCharacterDesignerControl()}>
        <Show
          when={characterDesignerTarget()}
          fallback={<div class="fixed right-4 top-16 z-40">{characterDesignerControl}</div>}
        >
          {(target) => <Portal mount={target()}>{characterDesignerControl}</Portal>}
        </Show>
      </Show>
      <Show when={showRoomDesignerControl()}>
        <Show
          when={roomDesignerTarget()}
          fallback={<div class="fixed right-4 top-16 z-40">{roomDesignerControl}</div>}
        >
          {(target) => <Portal mount={target()}>{roomDesignerControl}</Portal>}
        </Show>
      </Show>
      <Show when={showSceneEditorControl()}>
        <Show
          when={sceneEditorTarget()}
          fallback={<div class="fixed right-4 top-16 z-40">{sceneEditorControl}</div>}
        >
          {(target) => <Portal mount={target()}>{sceneEditorControl}</Portal>}
        </Show>
      </Show>
    </>
  )
}
