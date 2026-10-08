import type { PaneLeaf } from '@adea-ai/types/dev-runtime'
import { SplitLayout } from '@adea-ai/ui/components/layout/split-layout'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import type { Accessor, JSX } from 'solid-js'
import { Files, TerminalSquare } from 'lucide-solid'
import { Show, createMemo } from 'solid-js'

import { countLeaves, type DevLayoutState } from './operations'

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
          <PanePlaceholder terminal={false} unavailable={props.unavailable} />
        )
      }
    >
      {props.renderTerminalLeaf?.(content()) ?? (
        <PanePlaceholder terminal unavailable={props.unavailable} />
      )}
    </Show>
  )
}

/** The app supplies domain guidance; shared Empty owns the presentation. */
function PanePlaceholder(props: { terminal: boolean; unavailable: boolean }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle role="heading" aria-level={2}>
          {props.terminal
            ? props.unavailable
              ? 'Terminal unavailable'
              : 'Open a terminal'
            : 'Choose a file to edit'}
        </EmptyTitle>
        <EmptyDescription>
          {props.terminal
            ? props.unavailable
              ? 'Connect an available runtime to use terminals.'
              : 'Open a terminal in the selected session.'
            : 'Select a file from the Files panel.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

export function DevLayoutView(props: DevLayoutViewProps) {
  // Moving a pane needs a target leaf; with a single leaf the shared drag is
  // already a no-op, so the drag affordance (grip icon, draggable, grab
  // cursor) drops out by not forwarding onMove until a second pane exists.
  // SplitLayout reads this prop reactively, so the grip returns live when an
  // editor split appears.
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
      onMove={
        countLeaves(props.state.center) > 1
          ? (leafId, targetId, intent) =>
              props.onMoveTo(leafId, targetId, intent.placement, intent.direction)
          : undefined
      }
    />
  )
}
