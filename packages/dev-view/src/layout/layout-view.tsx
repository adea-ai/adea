import type { PaneLeaf, PaneNode, PaneSplit } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/ui/lib/utils'
import { Files, PanelRightOpen, TerminalSquare, X } from 'lucide-solid'
import { Match, Show, Switch } from 'solid-js'

import type { DevLayoutState } from './operations'

export type DevLayoutViewProps = Readonly<{
  state: DevLayoutState
  unavailable: boolean
  onClose(leafId: string): void
  onFocus(leafId: string): void
  onResize(splitId: string, ratio: number): void
}>

function Pane(props: {
  leaf: PaneLeaf
  focused: boolean
  unavailable: boolean
  onClose(): void
  onFocus(): void
}) {
  return (
    <section
      class={cn('dev-pane', { 'dev-pane--focused': props.focused })}
      data-pane-id={props.leaf.id}
      onPointerDown={props.onFocus}
    >
      <header>
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
          aria-label={`Close ${props.leaf.pane} pane`}
          onClick={(event) => {
            event.stopPropagation()
            props.onClose()
          }}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <Show
        when={props.leaf.pane === 'terminal'}
        fallback={
          <div class="dev-empty-state">
            <PanelRightOpen aria-hidden="true" />
            <h1>Choose a file to edit</h1>
            <p>File authority will arrive through the authenticated Dev Runtime.</p>
          </div>
        }
      >
        <div class="dev-terminal-placeholder">
          <p>$ dev runtime status</p>
          <p class="dev-terminal-muted">
            Authenticated terminal transport is not available in this slice.
          </p>
          <Show when={props.unavailable}>
            <p>Capability state: unavailable</p>
          </Show>
        </div>
      </Show>
    </section>
  )
}

function Split(props: {
  node: PaneSplit
  state: DevLayoutState
  unavailable: boolean
  onClose(leafId: string): void
  onFocus(leafId: string): void
  onResize(splitId: string, ratio: number): void
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
  onClose(leafId: string): void
  onFocus(leafId: string): void
  onResize(splitId: string, ratio: number): void
}) {
  return (
    <Switch>
      <Match when={props.node.kind === 'leaf' ? props.node : undefined}>
        {(leaf) => (
          <Pane
            leaf={leaf()}
            focused={props.state.focusedLeafId === leaf().id}
            unavailable={props.unavailable}
            onClose={() => props.onClose(leaf().id)}
            onFocus={() => props.onFocus(leaf().id)}
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
