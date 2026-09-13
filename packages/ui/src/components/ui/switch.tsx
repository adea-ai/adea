import { Switch as SwitchPrimitive } from '@kobalte/core/switch'
import { splitProps, type ComponentProps } from 'solid-js'

import { cn } from '#lib/utils'

type SwitchProps = ComponentProps<typeof SwitchPrimitive> & {
  class?: string
  size?: 'sm' | 'default'
}

function Switch(props: SwitchProps) {
  const [local, rest] = splitProps(props, ['class', 'size', 'aria-label', 'aria-describedby'])
  return (
    <SwitchPrimitive
      data-slot="switch"
      data-size={local.size ?? 'default'}
      class={cn('peer group/switch relative inline-flex shrink-0 items-center', local.class)}
      {...rest}
    >
      {/* The input is the real control: let it cover the visual track so
          pointer and keyboard interaction (and automated checks) use it
          directly, while the styled control stays the visible surface. */}
      <SwitchPrimitive.Input
        aria-label={local['aria-label']}
        aria-describedby={local['aria-describedby']}
        style={{
          position: 'absolute',
          inset: '0',
          width: '100%',
          height: '100%',
          margin: '0',
          padding: '0',
          border: '0',
          opacity: '0',
          cursor: 'pointer',
          // Undo the visually-hidden clipping so the input keeps a hit area
          // over the visual track: the input is the control.
          clip: 'auto',
          'clip-path': 'none',
          overflow: 'visible',
          'white-space': 'normal',
          'z-index': '2',
        }}
      />
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
