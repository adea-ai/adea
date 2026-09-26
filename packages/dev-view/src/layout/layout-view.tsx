import type { PaneLeaf, PaneNode, PaneSplit } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/app-ui/lib/utils'
import type { JSX } from 'solid-js'
import { Files, GripVertical, PanelRightOpen, TerminalSquare, X } from 'lucide-solid'
import { Match, Show, Switch, createSignal } from 'solid-js'

import type { DevLayoutState } from './operations'

export type DevLayoutViewProps = Readonly<{
  state: DevLayoutState
  unavailable: boolean
  /** #399: renders the central editor leaf when a file is open; when it
   *  returns undefined (or is omitted) the placeholder stays. */
  renderEditorLeaf?(leaf: PaneLeaf): JSX.Element | undefined
  /** Renders an attached terminal when an authenticated stream is available. */
  renderTerminalLeaf?(leaf: PaneLeaf): JSX.Element | undefined
  onClose(leafId: string): string
  onFocus(leafId: string): void
  onResize(splitId: string, ratio: number): void
  onMoveTo(
    leafId: string,
    targetLeafId: string,
    placement: 'before' | 'after',
    direction: 'row' | 'column'
  ): void
}>

type DropIntent = 'row-before' | 'row-after' | 'column-before' | 'column-after'

function dropIntentFor(event: DragEvent, element: HTMLElement): DropIntent {
  const bounds = element.getBoundingClientRect()
  const x = event.clientX - bounds.left
  const y = event.clientY - bounds.top
  const distances: readonly (readonly [DropIntent, number])[] = [
    ['row-before', x],
    ['row-after', bounds.width - x],
    ['column-before', y],
    ['column-after', bounds.height - y],
  ]
  let best: DropIntent = 'row-before'
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [intent, distance] of distances) {
    if (distance < bestDistance) {
      best = intent
      bestDistance = distance
    }
  }
  return best
}

function Pane(props: {
  leaf: PaneLeaf
  focused: boolean
  unavailable: boolean
  renderEditorLeaf?: (leaf: PaneLeaf) => JSX.Element | undefined
  /** Renders an attached terminal when an authenticated stream is available. */
  renderTerminalLeaf?: (leaf: PaneLeaf) => JSX.Element | undefined
  onClose(): string
  onFocus(): void
  onMoveTo(
    leafId: string,
    targetLeafId: string,
    placement: 'before' | 'after',
    direction: 'row' | 'column'
  ): void
}) {
  let sectionElement: HTMLElement | undefined
  const [dropIntent, setDropIntent] = createSignal<DropIntent | undefined>()
  const clearDrop = () => setDropIntent(undefined)
  return (
    <section
      ref={(element) => {
        sectionElement = element
      }}
      class={cn('dev-pane', { 'dev-pane--focused': props.focused })}
      data-pane-id={props.leaf.id}
      role="region"
      aria-label={`${props.leaf.pane} pane`}
      tabIndex={0}
      onFocus={props.onFocus}
      onDragOver={(event) => {
        if (!sectionElement || !event.dataTransfer) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropIntent(dropIntentFor(event, sectionElement))
      }}
      onDragLeave={clearDrop}
      onDrop={(event) => {
        event.preventDefault()
        const draggedId = event.dataTransfer?.getData('text/plain')
        const intent = dropIntent()
        clearDrop()
        if (!draggedId || !intent) return
        const [direction, placement] = intent.split('-') as ['row' | 'column', 'before' | 'after']
        props.onMoveTo(draggedId, props.leaf.id, placement, direction)
      }}
    >
      <header
        draggable={true}
        onDragStart={(event) => {
          event.dataTransfer?.setData('text/plain', props.leaf.id)
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={clearDrop}
      >
        <GripVertical aria-hidden="true" class="dev-pane-grip" />
        <Show when={props.leaf.pane === 'terminal'} fallback={<Files aria-hidden="true" />}>
          <TerminalSquare aria-hidden="true" />
        </Show>
        <span>{props.leaf.pane === 'terminal' ? 'Terminal' : 'Editor'}</span>
        <Show when={props.leaf.pane === 'terminal'}>
          <span class="dev-pane__badge">typed seam</span>
        </Show>
        <button
          type="button"
          class="dev-pane-close"
          draggable={false}
          aria-label={`Close ${props.leaf.pane} pane`}
          onClick={(event) => {
            event.stopPropagation()
            const nextFocusId = props.onClose()
            requestAnimationFrame(() => {
              const target = [...document.querySelectorAll<HTMLElement>('[data-pane-id]')].find(
                (element) => element.dataset.paneId === nextFocusId
              )
              target?.focus()
            })
          }}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <Show
        when={props.leaf.pane === 'terminal'}
        fallback={
          props.leaf.pane === 'editor' ? (
            (props.renderEditorLeaf?.(props.leaf) ?? (
              <div class="dev-empty-state">
                <PanelRightOpen aria-hidden="true" />
                <h1>Choose a file to edit</h1>
                <p>File authority will arrive through the authenticated Dev Runtime.</p>
              </div>
            ))
          ) : (
            <div class="dev-empty-state">
              <PanelRightOpen aria-hidden="true" />
              <h1>Choose a file to edit</h1>
              <p>File authority will arrive through the authenticated Dev Runtime.</p>
            </div>
          )
        }
      >
        {props.renderTerminalLeaf?.(props.leaf) ?? (
          <div class="dev-terminal-placeholder">
            <p>$ dev runtime status</p>
            <p class="dev-terminal-muted">
              Terminal output rides the authenticated terminal-bytes-v1 stream; this provider does
              not expose the attach seam yet, so no PTY is bound to this pane.
            </p>
            <Show when={props.unavailable}>
              <p>Capability state: unavailable</p>
            </Show>
          </div>
        )}
      </Show>
      <span class="sr-only" aria-live="polite">
        {dropIntent() ? 'Drop to place pane here' : ''}
      </span>
      <span
        class={cn('dev-pane-drop-hint', {
          'dev-pane--drop-row-before': dropIntent() === 'row-before',
          'dev-pane--drop-row-after': dropIntent() === 'row-after',
          'dev-pane--drop-column-before': dropIntent() === 'column-before',
          'dev-pane--drop-column-after': dropIntent() === 'column-after',
        })}
        aria-hidden="true"
      />
    </section>
  )
}

function Split(props: {
  node: PaneSplit
  state: DevLayoutState
  unavailable: boolean
  renderEditorLeaf?: (leaf: PaneLeaf) => JSX.Element | undefined
  renderTerminalLeaf?: (leaf: PaneLeaf) => JSX.Element | undefined
  onClose(leafId: string): string
  onFocus(leafId: string): void
  onResize(splitId: string, ratio: number): void
  onMoveTo(
    leafId: string,
    targetLeafId: string,
    placement: 'before' | 'after',
    direction: 'row' | 'column'
  ): void
}) {
  let splitElement: HTMLElement | undefined
  const resizeFromPointer = (event: PointerEvent) => {
    if (!splitElement) return
    const bounds = splitElement.getBoundingClientRect()
    const position =
      props.node.direction === 'row' ? event.clientX - bounds.left : event.clientY - bounds.top
    const extent = props.node.direction === 'row' ? bounds.width : bounds.height
    if (extent > 0) props.onResize(props.node.id, position / extent)
  }
  return (
    <section
      class={cn('dev-layout-node', {
        'dev-layout-node--row': props.node.direction === 'row',
        'dev-layout-node--column': props.node.direction === 'column',
        'dev-layout-node--ratio-10': Math.round(props.node.ratio * 20) * 5 === 10,
        'dev-layout-node--ratio-15': Math.round(props.node.ratio * 20) * 5 === 15,
        'dev-layout-node--ratio-20': Math.round(props.node.ratio * 20) * 5 === 20,
        'dev-layout-node--ratio-25': Math.round(props.node.ratio * 20) * 5 === 25,
        'dev-layout-node--ratio-30': Math.round(props.node.ratio * 20) * 5 === 30,
        'dev-layout-node--ratio-35': Math.round(props.node.ratio * 20) * 5 === 35,
        'dev-layout-node--ratio-40': Math.round(props.node.ratio * 20) * 5 === 40,
        'dev-layout-node--ratio-45': Math.round(props.node.ratio * 20) * 5 === 45,
        'dev-layout-node--ratio-50': Math.round(props.node.ratio * 20) * 5 === 50,
        'dev-layout-node--ratio-55': Math.round(props.node.ratio * 20) * 5 === 55,
        'dev-layout-node--ratio-60': Math.round(props.node.ratio * 20) * 5 === 60,
        'dev-layout-node--ratio-65': Math.round(props.node.ratio * 20) * 5 === 65,
        'dev-layout-node--ratio-70': Math.round(props.node.ratio * 20) * 5 === 70,
        'dev-layout-node--ratio-75': Math.round(props.node.ratio * 20) * 5 === 75,
        'dev-layout-node--ratio-80': Math.round(props.node.ratio * 20) * 5 === 80,
        'dev-layout-node--ratio-85': Math.round(props.node.ratio * 20) * 5 === 85,
        'dev-layout-node--ratio-90': Math.round(props.node.ratio * 20) * 5 === 90,
      })}
      ref={(element) => {
        splitElement = element
      }}
    >
      <LayoutNode {...props} node={props.node.children[0]} />
      <button
        type="button"
        class="dev-splitter"
        role="separator"
        aria-label="Resize workspace panes"
        aria-orientation={props.node.direction === 'row' ? 'vertical' : 'horizontal'}
        aria-valuemin="10"
        aria-valuemax="90"
        aria-valuenow={Math.round(props.node.ratio * 100)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          const done = () => {
            window.removeEventListener('pointermove', resizeFromPointer)
            window.removeEventListener('pointerup', done)
            window.removeEventListener('pointercancel', done)
          }
          window.addEventListener('pointermove', resizeFromPointer)
          window.addEventListener('pointerup', done, { once: true })
          window.addEventListener('pointercancel', done, { once: true })
        }}
        onKeyDown={(event) => {
          const delta =
            event.key === 'ArrowLeft' || event.key === 'ArrowUp'
              ? -0.05
              : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 0.05
                : 0
          if (!delta) return
          event.preventDefault()
          props.onResize(props.node.id, props.node.ratio + delta)
        }}
      />
      <LayoutNode {...props} node={props.node.children[1]} />
    </section>
  )
}

function LayoutNode(props: {
  node: PaneNode
  state: DevLayoutState
  unavailable: boolean
  renderEditorLeaf?: (leaf: PaneLeaf) => JSX.Element | undefined
  renderTerminalLeaf?: (leaf: PaneLeaf) => JSX.Element | undefined
  onClose(leafId: string): string
  onFocus(leafId: string): void
  onResize(splitId: string, ratio: number): void
  onMoveTo(
    leafId: string,
    targetLeafId: string,
    placement: 'before' | 'after',
    direction: 'row' | 'column'
  ): void
}) {
  return (
    <Switch>
      <Match when={props.node.kind === 'leaf' ? props.node : undefined}>
        {(leaf) => (
          <Pane
            leaf={leaf()}
            focused={props.state.focusedLeafId === leaf().id}
            unavailable={props.unavailable}
            renderEditorLeaf={props.renderEditorLeaf}
            renderTerminalLeaf={props.renderTerminalLeaf}
            onClose={() => props.onClose(leaf().id)}
            onFocus={() => props.onFocus(leaf().id)}
            onMoveTo={props.onMoveTo}
          />
        )}
      </Match>
      <Match when={props.node.kind === 'split' ? props.node : undefined}>
        {(split) => <Split {...props} node={split()} />}
      </Match>
    </Switch>
  )
}

export function DevLayoutView(props: DevLayoutViewProps) {
  return <LayoutNode {...props} node={props.state.center} />
}
