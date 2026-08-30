import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function ModalDialog({
  children,
  description,
  onClose,
  open,
  title,
}: Readonly<{
  children: ReactNode
  description?: string
  onClose: () => void
  open: boolean
  title: string
}>) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={dialogRef}
      className="conventional-dialog"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
    >
      <header>
        <div>
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        <button type="button" aria-label={`Close ${title}`} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      {children}
    </dialog>
  )
}
