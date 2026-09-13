import { ToggleGroup as ToggleGroupPrimitive } from '@kobalte/core/toggle-group'
import { type VariantProps } from 'class-variance-authority'
import { createContext, splitProps, useContext, type ComponentProps } from 'solid-js'

import { cn } from '#lib/utils'
import { toggleVariants } from '#components/ui/toggle'

type ToggleGroupContextValue = VariantProps<typeof toggleVariants> & {
  spacing: number
}

const ToggleGroupContext = createContext<ToggleGroupContextValue>({
  size: 'default',
  variant: 'default',
  spacing: 2,
})

type ToggleGroupProps = ComponentProps<typeof ToggleGroupPrimitive> &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
  }

function ToggleGroup(props: ToggleGroupProps) {
  const [local, rest] = splitProps(props, [
    'class',
    'variant',
    'size',
    'spacing',
    'orientation',
    'children',
  ])

  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={local.variant ?? 'default'}
      data-size={local.size ?? 'default'}
      data-spacing={local.spacing ?? 2}
      data-orientation={local.orientation ?? 'horizontal'}
      style={{ '--gap': local.spacing ?? 2 }}
      class={cn(
        'group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-lg data-[size=sm]:rounded-[min(var(--radius-md),10px)] data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch',
        local.class
      )}
      {...rest}
    >
      <ToggleGroupContext.Provider
        value={{
          variant: local.variant,
          size: local.size,
          spacing: local.spacing ?? 2,
        }}
      >
        {local.children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

type ToggleGroupItemProps = ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleVariants>

function ToggleGroupItem(props: ToggleGroupItemProps) {
  const [local, rest] = splitProps(props, ['class', 'children', 'variant', 'size'])
  const context = useContext(ToggleGroupContext)

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={context.variant ?? local.variant}
      data-size={context.size ?? local.size}
      data-spacing={context.spacing}
      class={cn(
        'shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-1.5 group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:first:rounded-l-lg group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:first:rounded-t-lg group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:last:rounded-r-lg group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:last:rounded-b-lg group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t',
        toggleVariants({
          variant: context.variant ?? local.variant,
          size: context.size ?? local.size,
        }),
        local.class
      )}
      {...rest}
    >
      {local.children}
    </ToggleGroupPrimitive.Item>
  )
}

export { ToggleGroup, ToggleGroupItem, type ToggleGroupItemProps, type ToggleGroupProps }
