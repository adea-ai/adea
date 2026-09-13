import { DropdownMenu as DropdownMenuPrimitive } from '@kobalte/core/dropdown-menu'
import { ChevronRightIcon, CheckIcon } from 'lucide-solid'
import { splitProps, type ComponentProps } from 'solid-js'

import { cn } from '#lib/utils'

type DropdownMenuContentProps = ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  alignOffset?: number
}

function DropdownMenu(props: ComponentProps<typeof DropdownMenuPrimitive>) {
  return <DropdownMenuPrimitive data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal(props: ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger(props: ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent(props: DropdownMenuContentProps) {
  const [local, rest] = splitProps(props, ['class', 'side', 'align', 'sideOffset', 'children'])
  const placement = () => `${local.side ?? 'bottom'}${local.align ? `-${local.align}` : ''}`

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        placement={placement()}
        gutter={local.sideOffset ?? 4}
        class={cn(
          'z-[140] max-h-(--kb-popper-available-height) min-w-32 origin-(--kb-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-expanded:animate-in data-expanded:fade-in-0 data-expanded:zoom-in-95',
          local.class
        )}
        {...rest}
      >
        {local.children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuGroup(props: ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

function DropdownMenuLabel(
  props: ComponentProps<typeof DropdownMenuPrimitive.GroupLabel> & {
    inset?: boolean
  }
) {
  const [local, rest] = splitProps(props, ['class', 'inset'])
  return (
    <DropdownMenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={local.inset}
      class={cn(
        'px-1.5 py-1 text-xs font-medium text-muted-foreground data-[inset]:pl-7',
        local.class
      )}
      {...rest}
    />
  )
}

function DropdownMenuItem(
  props: ComponentProps<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean
    variant?: 'default' | 'destructive'
  }
) {
  const [local, rest] = splitProps(props, ['class', 'inset', 'variant'])
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={local.inset}
      data-variant={local.variant ?? 'default'}
      class={cn(
        "group/dropdown-menu-item relative flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-[inset]:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:not-data-[variant=destructive]:text-accent-foreground data-[variant=destructive]:data-highlighted:bg-destructive/10 data-[variant=destructive]:data-highlighted:text-destructive data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
        local.class
      )}
      {...rest}
    />
  )
}

function DropdownMenuSub(props: ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger(
  props: ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean
  }
) {
  const [local, rest] = splitProps(props, ['class', 'inset', 'children'])
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={local.inset}
      class={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[inset]:pl-7 data-expanded:bg-accent data-expanded:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        local.class
      )}
      {...rest}
    >
      {local.children}
      <ChevronRightIcon class="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent(props: ComponentProps<typeof DropdownMenuContent>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      class={cn(
        'w-auto min-w-[96px] rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-100 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-expanded:animate-in data-expanded:fade-in-0 data-expanded:zoom-in-95',
        local.class
      )}
      {...rest}
    />
  )
}

function DropdownMenuCheckboxItem(
  props: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
    inset?: boolean
  }
) {
  const [local, rest] = splitProps(props, ['class', 'children', 'inset'])
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={local.inset}
      class={cn(
        "relative flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-[inset]:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        local.class
      )}
      {...rest}
    >
      <span
        class="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {local.children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup(props: ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem(
  props: ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
    inset?: boolean
  }
) {
  const [local, rest] = splitProps(props, ['class', 'children', 'inset'])
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={local.inset}
      class={cn(
        "relative flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-[inset]:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        local.class
      )}
      {...rest}
    >
      <span
        class="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {local.children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuSeparator(props: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      class={cn('-mx-1 my-1 h-px bg-border', local.class)}
      {...rest}
    />
  )
}

function DropdownMenuShortcut(props: ComponentProps<'span'>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      class={cn(
        'ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground',
        local.class
      )}
      {...rest}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
