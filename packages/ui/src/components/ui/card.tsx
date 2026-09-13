import { splitProps, type ComponentProps } from 'solid-js'

import { cn } from '#lib/utils'

function Card(props: ComponentProps<'div'>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <div
      data-slot="card"
      class={cn('rounded-xl border bg-card text-card-foreground shadow-sm', local.class)}
      {...rest}
    />
  )
}

function CardContent(props: ComponentProps<'div'>) {
  const [local, rest] = splitProps(props, ['class'])
  return <div data-slot="card-content" class={cn('p-4', local.class)} {...rest} />
}

export { Card, CardContent }
