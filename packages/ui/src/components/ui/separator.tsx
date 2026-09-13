import { Separator as SeparatorPrimitive } from '@kobalte/core/separator'
import { splitProps, type ComponentProps } from 'solid-js'

import { cn } from '#lib/utils'

type SeparatorProps = ComponentProps<typeof SeparatorPrimitive> & {
  orientation?: 'horizontal' | 'vertical'
}

function Separator(props: SeparatorProps) {
  const [local, rest] = splitProps(props, ['class', 'orientation'])
  const orientation = () => local.orientation ?? 'horizontal'

  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation()}
      class={cn(
        'shrink-0 bg-border',
        orientation() === 'vertical' ? 'w-px self-stretch' : 'h-px w-full',
        local.class
      )}
      {...rest}
    />
  )
}

export { Separator }
