import { Switch as SwitchPrimitive } from '@kobalte/core/switch'
import { splitProps, type ComponentProps } from 'solid-js'

import { cn } from '#lib/utils'

type SwitchProps = ComponentProps<typeof SwitchPrimitive> & {
  class?: string
  size?: 'sm' | 'default'
}

function Switch(props: SwitchProps) {
  const [local, rest] = splitProps(props, ['class', 'size'])
  return (
    <SwitchPrimitive
      data-slot="switch"
      data-size={local.size ?? 'default'}
      class={cn('peer group/switch relative inline-flex shrink-0 items-center', local.class)}
      {...rest}
    >
      <SwitchPrimitive.Input />
      <SwitchPrimitive.Control
        class={cn(
          'inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 group-data-[size=default]/switch:h-[18.4px] group-data-[size=default]/switch:w-[32px] group-data-[size=sm]/switch:h-[14px] group-data-[size=sm]/switch:w-[24px] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 group-data-checked/switch:bg-primary group-not-data-checked/switch:bg-input dark:group-not-data-checked/switch:bg-input/80 group-data-disabled/switch:cursor-not-allowed group-data-disabled/switch:opacity-50'
        )}
      >
        <SwitchPrimitive.Thumb
          data-slot="switch-thumb"
          class="pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-checked/switch:translate-x-[calc(100%-2px)] dark:group-data-checked/switch:bg-primary-foreground dark:group-not-data-checked/switch:bg-foreground"
        />
      </SwitchPrimitive.Control>
    </SwitchPrimitive>
  )
}

export { Switch }
