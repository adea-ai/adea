import type { HTMLAttributes } from 'react'
import { cn } from '#lib/utils'

function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card"
      className={cn('rounded-xl border bg-card text-card-foreground shadow-sm', className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="card-content" className={cn('p-4', className)} {...props} />
}

export { Card, CardContent }
