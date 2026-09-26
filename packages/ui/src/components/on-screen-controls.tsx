import { ZoomIn, ZoomOut } from 'lucide-solid'
import { onCleanup, Show, type JSX } from 'solid-js'

import { Button } from '@adea-ai/ui/components/ui/button'
import { cn } from '#lib/utils'

type ControlButtonProps = {
  code: string
  label: string
  children: JSX.Element
  class?: string
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
    <button
      type="button"
      aria-label={props.label}
      class={cn(
        'flex size-14 touch-none select-none items-center justify-center rounded-2xl border border-scrim-edge/25 bg-scrim/65 p-2 text-scrim-foreground shadow-lg backdrop-blur-sm transition active:scale-95 [-webkit-touch-callout:none] [-webkit-user-select:none]',
        props.class
      )}
      onContextMenu={(event) => event.preventDefault()}
      onPointerCancel={release}
      onPointerDown={press}
      onPointerLeave={release}
      onPointerUp={release}
    >
      {props.children}
    </button>
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
      class="pointer-events-none fixed inset-x-4 bottom-4 z-30 flex select-none items-end justify-between gap-4 pb-[env(safe-area-inset-bottom)] sm:inset-x-6 sm:bottom-6 [-webkit-touch-callout:none] [-webkit-user-select:none]"
    >
      <Show when={showMovementControls()}>
        <div class="pointer-events-auto grid grid-cols-3 gap-1.5 rounded-3xl bg-scrim/20 p-2 backdrop-blur-[2px]">
          <span />
          <ControlButton code="KeyW" label="Move forward" class="size-12 rounded-xl text-xl">
            ▲
          </ControlButton>
          <span />
          <ControlButton code="KeyA" label="Move left" class="size-12 rounded-xl text-xl">
            ◀
          </ControlButton>
          <ControlButton code="KeyS" label="Move backward" class="size-12 rounded-xl text-xl">
            ▼
          </ControlButton>
          <ControlButton code="KeyD" label="Move right" class="size-12 rounded-xl text-xl">
            ▶
          </ControlButton>
        </div>
      </Show>
      <div class="pointer-events-auto ml-auto flex flex-col items-end gap-2">
        <Show when={showZoomControls()}>
          <div
            class="flex items-center gap-1.5 rounded-2xl bg-scrim/20 p-1.5 backdrop-blur-[2px]"
            role="group"
            aria-label="Camera zoom"
          >
            <Button
              type="button"
              variant="secondary"
              size="icon-lg"
              aria-label="Zoom out"
              title="Zoom out"
              class="workspace-on-screen-controls-zoom-button"
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
              class="workspace-on-screen-controls-zoom-button"
              onClick={() => props.onZoomIn?.()}
            >
              <ZoomIn aria-hidden="true" />
            </Button>
          </div>
        </Show>
        <Show when={showJumpControl()}>
          <ControlButton code="Space" label="Jump" class="text-xs font-semibold">
            JUMP
          </ControlButton>
        </Show>
      </div>
    </div>
  )
}
