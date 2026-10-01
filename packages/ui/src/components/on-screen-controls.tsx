import { ZoomIn, ZoomOut } from 'lucide-solid'
import { onCleanup, Show, type JSX } from 'solid-js'

import { Button } from '@adea-ai/ui/components/ui/button'

type ControlButtonProps = {
  code: string
  label: string
  children: JSX.Element
}

function sendKeyEvent(type: 'keydown' | 'keyup', code: string): void {
  window.dispatchEvent(
    new KeyboardEvent(type, { bubbles: true, cancelable: true, code, key: code })
  )
}

function ControlButton(props: ControlButtonProps) {
  let pressed = false
  let pressedPointer: number | null = null

  const release = () => {
    if (!pressed) return
    pressed = false
    pressedPointer = null
    sendKeyEvent('keyup', props.code)
  }

  // Self-heal: release the key if the pointerup lands elsewhere (e.g. the
  // scene DOM changes mid-teleport) or the window loses focus. PointerId
  // matching preserves multi-touch.
  if (typeof window !== 'undefined') {
    const onWindowPointerUp = (event: PointerEvent) => {
      if (pressedPointer === event.pointerId) release()
    }
    const onBlur = () => release()
    window.addEventListener('pointerup', onWindowPointerUp)
    window.addEventListener('blur', onBlur)
    onCleanup(() => {
      window.removeEventListener('pointerup', onWindowPointerUp)
      window.removeEventListener('blur', onBlur)
    })
  }

  const press = (event: PointerEvent & { currentTarget: HTMLButtonElement }) => {
    event.preventDefault()
    if (pressed) return
    pressed = true
    pressedPointer = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    sendKeyEvent('keydown', props.code)
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon-xl"
      aria-label={props.label}
      class="touch-none select-none"
      onContextMenu={(event) => event.preventDefault()}
      onPointerCancel={release}
      onPointerDown={press}
      onPointerLeave={release}
      onPointerUp={release}
    >
      {props.children}
    </Button>
  )
}

export type OnScreenControlsProps = {
  onZoomIn?: () => void
  onZoomOut?: () => void
  showMovementControls?: boolean
  showJumpControl?: boolean
}

export function OnScreenControls(props: OnScreenControlsProps) {
  const showMovementControls = () => props.showMovementControls ?? true
  const showJumpControl = () => props.showJumpControl ?? true
  const showZoomControls = () => Boolean(props.onZoomIn && props.onZoomOut)

  return (
    <div
      data-agent-hq-on-screen-controls
      class="workspace-on-screen-controls pointer-events-none fixed inset-x-4 bottom-4 z-30 flex select-none items-end justify-between gap-4 sm:inset-x-6 sm:bottom-6"
    >
      <Show when={showMovementControls()}>
        <div class="pointer-events-auto grid grid-cols-3 gap-1.5 rounded-3xl bg-scrim/20 p-2 backdrop-blur-sm">
          <span />
          <ControlButton code="KeyW" label="Move forward">
            ▲
          </ControlButton>
          <span />
          <ControlButton code="KeyA" label="Move left">
            ◀
          </ControlButton>
          <ControlButton code="KeyS" label="Move backward">
            ▼
          </ControlButton>
          <ControlButton code="KeyD" label="Move right">
            ▶
          </ControlButton>
        </div>
      </Show>
      <div class="pointer-events-auto ml-auto flex flex-col items-end gap-2">
        <Show when={showZoomControls()}>
          <div
            class="flex items-center gap-1.5 rounded-2xl bg-scrim/20 p-1.5 backdrop-blur-sm"
            role="group"
            aria-label="Camera zoom"
          >
            <Button
              type="button"
              variant="secondary"
              size="icon-lg"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => props.onZoomOut?.()}
            >
              <ZoomOut aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="icon-lg"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => props.onZoomIn?.()}
            >
              <ZoomIn aria-hidden="true" />
            </Button>
          </div>
        </Show>
        <Show when={showJumpControl()}>
          <ControlButton code="Space" label="Jump">
            JUMP
          </ControlButton>
        </Show>
      </div>
    </div>
  )
}
