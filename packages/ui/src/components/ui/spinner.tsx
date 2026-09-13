import { LoaderCircle } from 'lucide-solid'
import { splitProps, type ComponentProps } from 'solid-js'

import { cn } from '#lib/utils'

type SpinnerProps = ComponentProps<typeof LoaderCircle>

function Spinner(props: SpinnerProps) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <LoaderCircle
      role="status"
      aria-label="Loading"
      class={cn('animate-spin', local.class)}
      {...rest}
    />
  )
}

export { Spinner }
