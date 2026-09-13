import { splitProps, type ComponentProps } from 'solid-js'

import { cn } from '#lib/utils'

function Skeleton(props: ComponentProps<'div'>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <div
      data-slot="skeleton"
      class={cn('animate-pulse rounded-md bg-muted', local.class)}
      {...rest}
    />
  )
}

export { Skeleton }
