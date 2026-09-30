import type { PaneLeaf } from '@adea-ai/types/dev-runtime'
import { SplitLayout } from '@adea-ai/ui/components/layout/split-layout'
import type { Accessor, JSX } from 'solid-js'
import { Files, PanelRightOpen, TerminalSquare } from 'lucide-solid'
import { Show, createMemo } from 'solid-js'

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

/** Domain content only; shared UI owns stable pane owners, drag, separators and focus return. */
function PaneContent(props: {
  leaf: Accessor<PaneLeaf>
  unavailable: boolean
  renderEditorLeaf?: DevLayoutViewProps['renderEditorLeaf']
  renderTerminalLeaf?: DevLayoutViewProps['renderTerminalLeaf']
}) {
  // Payload updates are reactive, but a new structural leaf object must not
  // recreate a mounted domain renderer when its actual resource is unchanged.
  const content = createMemo(() => props.leaf(), undefined, {
    equals: (previous, next) =>
      previous.pane === next.pane && previous.resourceId === next.resourceId,
  })
  return (
    <Show
      when={content().pane === 'terminal'}
      fallback={
        props.renderEditorLeaf?.(content()) ?? (
          <div class="dev-empty-state">
            <PanelRightOpen aria-hidden="true" />
            <h1>Choose a file to edit</h1>
            <p>File authority will arrive through the authenticated Dev Runtime.</p>
          </div>
        )
      }
  >
      {props.renderTerminalLeaf?.(content()) ?? (
        <div class="dev-terminal-placeholder">
          <p>$ dev runtime status</p>
          <p class="dev-terminal-muted">
            Terminal output rides the authenticated terminal-bytes-v1 stream; this provider does not
            expose the attach seam yet, so no PTY is bound to this pane.
          </p>
          <Show when={props.unavailable}>
            <p>Capability state: unavailable</p>
          </Show>
        </div>
      )}
    </Show>
  )
}

export function DevLayoutView(props: DevLayoutViewProps) {
  return (
    <SplitLayout
      state={props.state}
      label="Developer center panes"
      labelForLeaf={(leaf) => `${leaf.pane} pane`}
      labelForSeparator={() => 'Resize workspace panes'}
      paneTabIndex={0}
      renderPaneLabel={(leaf) => (
        <span class="dev-center-pane-label">
          <Show when={leaf().pane === 'terminal'} fallback={<Files aria-hidden="true" />}>
            <TerminalSquare aria-hidden="true" />
          </Show>
          <span>{leaf().pane === 'terminal' ? 'Terminal' : 'Editor'}</span>
        </span>
      )}
      renderLeaf={(leaf) => (
        <PaneContent
          leaf={leaf}
          unavailable={props.unavailable}
          renderEditorLeaf={props.renderEditorLeaf}
          renderTerminalLeaf={props.renderTerminalLeaf}
        />
      )}
      onClose={props.onClose}
      onFocus={props.onFocus}
      onResize={props.onResize}
      onMove={(leafId, targetId, intent) =>
        props.onMoveTo(leafId, targetId, intent.placement, intent.direction)
      }
    />
  )
}
