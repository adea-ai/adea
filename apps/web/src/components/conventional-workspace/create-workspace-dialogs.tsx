import { useState } from 'react'
import type { WorkspaceSceneId } from '@agent-hq/types'

import { ModalDialog } from './modal-dialog'

const roomTemplates: Record<
  WorkspaceSceneId,
  readonly Readonly<{ functionKey: string; name: string }>[]
> = {
  home: [
    { functionKey: 'study', name: 'Study' },
    { functionKey: 'kitchen', name: 'Kitchen' },
    { functionKey: 'travel', name: 'Travel' },
  ],
  work: [
    { functionKey: 'engineering', name: 'Engineering' },
    { functionKey: 'marketing', name: 'Marketing' },
    { functionKey: 'operations', name: 'Operations' },
  ],
}

export function CreateRoomDialog({
  busy,
  onClose,
  onCreate,
  open,
  template,
}: Readonly<{
  busy: boolean
  onClose: () => void
  onCreate: (input: Readonly<{ functionKey: string; name: string }>) => Promise<void>
  open: boolean
  template: WorkspaceSceneId
}>) {
  const [error, setError] = useState<string | null>(null)
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="Create Room"
      description="Rooms are the primary functional contexts in Agent HQ."
    >
      <div className="conventional-template-options" aria-label={`${template} Room suggestions`}>
        {roomTemplates[template].map((room) => (
          <button
            key={room.functionKey}
            type="button"
            disabled={busy}
            onClick={() =>
              void onCreate(room)
                .then(onClose)
                .catch(() => setError('Room could not be created.'))
            }
          >
            <strong>{room.name}</strong>
            <span>{template === 'work' ? 'Work template' : 'Home template'}</span>
          </button>
        ))}
      </div>
      <form
        className="conventional-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          void onCreate({
            functionKey: String(form.get('functionKey') ?? ''),
            name: String(form.get('name') ?? ''),
          })
            .then(onClose)
            .catch(() => setError('Room could not be created. Check the fields and retry.'))
        }}
      >
        <label>
          Room name
          <input name="name" required maxLength={120} />
        </label>
        <label>
          Function key
          <input name="functionKey" required pattern="[a-z0-9-]+" maxLength={80} />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" className="conventional-primary-button" disabled={busy}>
          {busy ? 'Creating…' : 'Create Room'}
        </button>
      </form>
    </ModalDialog>
  )
}

export function CreateGroupDialog({
  busy,
  onClose,
  onCreate,
  open,
}: Readonly<{
  busy: boolean
  onClose: () => void
  onCreate: (title: string) => Promise<void>
  open: boolean
}>) {
  const [error, setError] = useState<string | null>(null)
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="New group conversation"
      description="A durable conversation for users and multiple Agents, without requiring a Room."
    >
      <form
        className="conventional-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          const title = String(new FormData(event.currentTarget).get('title') ?? '')
          void onCreate(title)
            .then(onClose)
            .catch(() => setError('Group conversation could not be created.'))
        }}
      >
        <label>
          Conversation name
          <input name="title" required maxLength={120} autoFocus />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" className="conventional-primary-button" disabled={busy}>
          {busy ? 'Creating…' : 'Create conversation'}
        </button>
      </form>
    </ModalDialog>
  )
}
