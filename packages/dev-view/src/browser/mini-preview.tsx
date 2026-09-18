/*
 * Movable, resizable mini preview within the app bounds (issue #422 UX
 * contract). Pointer-gesture structure follows t3code's
 * ThreadPreviewMiniPlayer (MIT, revision
 * 77bca8b2d76a1f42552e5eee7d277fcb1160347a); geometry comes from the
 * transcribed pure layout module. The live frame travels to CSS through
 * custom properties because the geometry is dynamic by definition; the
 * stylesheet maps them onto the real properties.
 */
import { Show, createSignal, onCleanup, onMount } from 'solid-js'

import type { BrowserLane } from '@adea-ai/types/dev-runtime'

import {
  PREVIEW_MINI_PLAYER_CORNER_RADIUS,
  resolveDeviceMiniPlayerSourceSize,
  resolvePreviewMiniPlayerFrame,
  resizePreviewMiniPlayer,
  type BrowserViewportResizeDirection,
  type PreviewMiniPlayerFrame,
} from './mini-preview-layout'

const PLACEHOLDER_SOURCE = resolveDeviceMiniPlayerSourceSize('ios', null)

const RESIZE_DIRECTIONS: readonly { direction: BrowserViewportResizeDirection; class: string }[] = [
  { direction: 'north', class: 'dev-browser-mini__handle--n' },
  { direction: 'south', class: 'dev-browser-mini__handle--s' },
  { direction: 'west', class: 'dev-browser-mini__handle--w' },
  { direction: 'east', class: 'dev-browser-mini__handle--e' },
  { direction: 'northwest', class: 'dev-browser-mini__handle--nw' },
  { direction: 'northeast', class: 'dev-browser-mini__handle--ne' },
  { direction: 'southwest', class: 'dev-browser-mini__handle--sw' },
  { direction: 'southeast', class: 'dev-browser-mini__handle--se' },
]

export function MiniPreview(props: { lane?: BrowserLane; onClose(): void }) {
  const [frame, setFrame] = createSignal<PreviewMiniPlayerFrame>({
    x: 24,
    y: 24,
    width: 320,
    height: 200,
  })
  // Assigned through the Solid `ref` attribute below.
  // oxlint-disable-next-line no-unassigned-vars -- Solid ref assignment
  let container: HTMLDivElement | undefined
  let drag:
    | {
        pointerId: number
        startX: number
        startY: number
        startFrame: PreviewMiniPlayerFrame
        direction: BrowserViewportResizeDirection | null
      }
    | undefined

  function relayout(): void {
    const bounds = container?.getBoundingClientRect()
    if (!bounds) return
    setFrame((current) =>
      resolvePreviewMiniPlayerFrame({
        width: current.width,
        position: { x: current.x, y: current.y },
        source: PLACEHOLDER_SOURCE,
        container: { width: bounds.width, height: bounds.height },
      })
    )
  }

  function onPointerDown(
    event: PointerEvent,
    direction: BrowserViewportResizeDirection | null
  ): void {
    if (event.button !== 0 || drag) return
    event.stopPropagation()
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startFrame: frame(),
      direction,
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return
    const delta = { x: event.clientX - drag.startX, y: event.clientY - drag.startY }
    const bounds = container?.getBoundingClientRect()
    if (!bounds) return
    const containerSize = { width: bounds.width, height: bounds.height }
    if (drag.direction) {
      setFrame(
        resizePreviewMiniPlayer({
          start: drag.startFrame,
          direction: drag.direction,
          delta,
          source: PLACEHOLDER_SOURCE,
          container: containerSize,
        })
      )
      return
    }
    setFrame(
      resolvePreviewMiniPlayerFrame({
        width: drag.startFrame.width,
        position: { x: drag.startFrame.x + delta.x, y: drag.startFrame.y + delta.y },
        source: PLACEHOLDER_SOURCE,
        container: containerSize,
      })
    )
  }

  function onPointerUp(event: PointerEvent): void {
    if (drag && event.pointerId === drag.pointerId) drag = undefined
  }

  onMount(() => {
    relayout()
    window.addEventListener('resize', relayout)
  })
  onCleanup(() => window.removeEventListener('resize', relayout))

  return (
    <div ref={container} class="dev-browser-mini__layer">
      <section
        class="dev-browser-mini"
        style={{
          '--mini-left': `${frame().x}px`,
          '--mini-top': `${frame().y}px`,
          '--mini-width': `${frame().width}px`,
          '--mini-height': `${frame().height}px`,
          '--mini-radius': `${PREVIEW_MINI_PLAYER_CORNER_RADIUS}px`,
        }}
        aria-label="Floating browser preview"
      >
        <div class="dev-browser-mini__status">
          <button
            type="button"
            class="dev-icon-button"
            aria-label="Close floating preview"
            onClick={props.onClose}
            onPointerDown={(event) => event.stopPropagation()}
          >
            ×
          </button>
        </div>
        <div
          class="dev-browser-mini__viewport"
          data-empty={props.lane ? 'false' : 'true'}
          role="status"
        >
          <Show when={props.lane} fallback={<span>No lane attached</span>}>
            {(lane) => (
              <span class="dev-terminal-muted">
                Mirroring {lane().kind} · gen {lane().generation}
              </span>
            )}
          </Show>
        </div>
        {/* Drag strip: pointerdown without a direction moves the frame. */}
        <div
          class="dev-browser-mini__handle dev-browser-mini__handle--move"
          role="presentation"
          onPointerDown={(event) => onPointerDown(event, null)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        {RESIZE_DIRECTIONS.map((handle) => (
          <div
            class={`dev-browser-mini__handle ${handle.class}`}
            role="presentation"
            onPointerDown={(event) => onPointerDown(event, handle.direction)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        ))}
      </section>
    </div>
  )
}
