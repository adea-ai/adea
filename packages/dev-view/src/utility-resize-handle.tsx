import { PixelResizeHandle } from '@adea-ai/ui/components/layout/contextual-sidebar'

import { snapUtilitySize, utilitySizeSteps } from './utility-model'

/** Adapt Dev's persisted utility sizes to the shared edge ruler. */
export function UtilityResizeHandle(props: {
  side: 'left' | 'right'
  size: number
  onResize(size: number): void
}) {
  const steps = utilitySizeSteps[props.side]

  // The host-owned wrapper lifts the ruler over the pane and hides it with the
  // workspace's focus/full layouts; the shared rung grip is left as published.
  return (
    <div class="dev-utility-splitter">
      <PixelResizeHandle
        side={props.side}
        value={props.size}
        minimum={steps[0]}
        maximum={steps[steps.length - 1]!}
        step={48}
        label={`Resize ${props.side} utility pane`}
        controls={`dev-utility-panel-${props.side}`}
        onChange={(size) => props.onResize(snapUtilitySize(size, props.side))}
      />
    </div>
  )
}
