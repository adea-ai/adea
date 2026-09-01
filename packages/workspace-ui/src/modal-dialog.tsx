import type { ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@agent-hq/ui/components/ui/dialog'
import { cn } from '@agent-hq/ui/lib/utils'

export function ModalDialog({
  children,
  className,
  description,
  onClose,
  open,
  title,
}: Readonly<{
  children: ReactNode
  className?: string
  description?: string
  onClose: () => void
  open: boolean
  title: string
}>) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className={cn('conventional-dialog', className)}>
        <DialogHeader className="conventional-dialog__header">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}
