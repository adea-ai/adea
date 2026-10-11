import { PixelResizeHandle } from '@adea-ai/ui/components/layout/contextual-sidebar'
import { cn } from '@adea-ai/app-ui/lib/utils'

import { snapUtilitySize, utilitySizeSteps } from './utility-model'

/** Adapt Dev's persisted utility sizes to the shared edge ruler. */
export function UtilityResizeHandle(props: {
  side: 'left' | 'right'
  size: number
  onResize(size: number): void
}) {
  const steps = utilitySizeSteps[props.side]

  return (
    <PixelResizeHandle
      side={props.side}
      value={props.size}
      minimum={steps[0]}
      maximum={steps[steps.length - 1]!}
      step={48}
      label={`Resize ${props.side} utility pane`}
      controls={`dev-utility-panel-${props.side}`}
      class={cn('dev-utility-splitter', {
        'dev-utility-splitter--left': props.side === 'left',
        'dev-utility-splitter--right': props.side === 'right',
      })}
      onChange={(size) => props.onResize(snapUtilitySize(size, props.side))}
    />
  )
}
