import { LoaderCircle } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '#lib/utils'

function Spinner({ className, ...props }: ComponentProps<typeof LoaderCircle>) {
  return (
    <LoaderCircle
      role="status"
      aria-label="Loading"
      className={cn('animate-spin', className)}
      {...props}
    />
  )
}

export { Spinner }
