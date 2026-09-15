import type { PaneLeaf, PaneNode, PaneSplit } from '@adea-ai/types/dev-runtime'
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
      class="dev-pane"
      classList={{ 'dev-pane--focused': props.focused }}
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
      class={`dev-layout-node dev-layout-node--${props.node.direction}`}
      style={{ '--dev-node-ratio': `${props.node.ratio * 100}%` }}
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
