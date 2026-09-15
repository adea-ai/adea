import { Tooltip as TooltipPrimitive } from '@kobalte/core/tooltip'
import {
  createContext,
  splitProps,
  useContext,
  type ComponentProps,
  type ParentProps,
} from 'solid-js'

import { cn } from '#lib/utils'

const TOOLTIP_DELAY = 200

const TooltipDelayContext = createContext<number>(TOOLTIP_DELAY)

function TooltipProvider(props: ParentProps<{ delay?: number }>) {
  return (
    <TooltipDelayContext.Provider value={props.delay ?? TOOLTIP_DELAY}>
      {props.children}
    </TooltipDelayContext.Provider>
  )
}

function Tooltip(props: ComponentProps<typeof TooltipPrimitive>) {
  const delay = useContext(TooltipDelayContext)
  return <TooltipPrimitive openDelay={delay} data-slot="tooltip" {...props} />
}

function TooltipTrigger(props: ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

type TooltipContentProps = ComponentProps<typeof TooltipPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left'
  sideOffset?: number
  align?: 'start' | 'center' | 'end'
}

function TooltipContent(props: TooltipContentProps) {
  const [local, rest] = splitProps(props, ['class', 'side', 'sideOffset', 'align', 'children'])
  const placement = () => `${local.side ?? 'top'}${local.align ? `-${local.align}` : ''}`

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        placement={placement()}
        gutter={local.sideOffset ?? 4}
        class={cn(
          'z-(--z-tooltip) max-w-72 rounded-md bg-popover px-2.5 py-1.5 text-sm leading-5 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-closed:animate-out data-closed:fade-out-0 data-expanded:animate-in data-expanded:fade-in-0',
          local.class
        )}
        {...rest}
      >
        {local.children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TOOLTIP_DELAY }
