import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@adea-ai/ui/components/ui/resizable'
import { cn } from '@adea-ai/app-ui/lib/utils'

import { snapUtilitySize, utilitySizeSteps } from './utility-model'

/** The same edge resize affordance is shared by Dev and cross-view utilities. */
export function UtilityResizeHandle(props: {
  side: 'left' | 'right'
  size: number
  onResize(size: number): void
}) {
  const steps = utilitySizeSteps[props.side]
  const max = steps[steps.length - 1]
  const sizeRatio = () => props.size / max
  const rulerSizes = () =>
    props.side === 'left' ? [sizeRatio(), 1 - sizeRatio()] : [1 - sizeRatio(), sizeRatio()]
  const resizedSize = (sizes: readonly number[]) =>
    Math.round((props.side === 'left' ? (sizes[0] ?? 0) : 1 - (sizes[0] ?? 1)) * max)

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      sizes={rulerSizes()}
      keyboardDelta="48px"
      class={cn('dev-utility-splitter', {
        'dev-utility-splitter--left': props.side === 'left',
        'dev-utility-splitter--right': props.side === 'right',
      })}
      onSizesChange={(sizes) => {
        const nextSize = snapUtilitySize(resizedSize(sizes), props.side)
        if (nextSize !== props.size) props.onResize(nextSize)
      }}
    >
      <ResizablePanel
        minSize={props.side === 'left' ? steps[0] / max : 0}
        maxSize={props.side === 'left' ? 1 : (max - steps[0]) / max}
        aria-hidden="true"
      />
      <ResizableHandle
        withHandle
        label={`Resize ${props.side} utility pane`}
        aria-controls={`dev-utility-panel-${props.side}`}
        aria-valuemin={steps[0]}
        aria-valuemax={max}
        aria-valuenow={props.size}
        class="dev-utility-splitter__handle"
      />
      <ResizablePanel
        minSize={props.side === 'left' ? 0 : steps[0] / max}
        maxSize={1}
        aria-hidden="true"
      />
    </ResizablePanelGroup>
  )
}
