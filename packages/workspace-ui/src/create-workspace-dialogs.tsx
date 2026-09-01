import { useState } from 'react'
import type { WorkspaceSceneId } from '@agent-hq/types'
import { Button } from '@agent-hq/ui/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@agent-hq/ui/components/ui/field'
import { Input } from '@agent-hq/ui/components/ui/input'

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
          <Button
            key={room.functionKey}
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void onCreate(room)
                .then(onClose)
                .catch(() => setError('Room could not be created.'))
            }
          >
            <strong>{room.name}</strong>
            <span>{template === 'work' ? 'Work template' : 'Home template'}</span>
          </Button>
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
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="room-name">Room name</FieldLabel>
            <Input id="room-name" name="name" required maxLength={120} />
          </Field>
          <Field>
            <FieldLabel htmlFor="room-function-key">Function key</FieldLabel>
            <Input
              id="room-function-key"
              name="functionKey"
              required
              pattern={'[a-z0-9\\-]+'}
              maxLength={80}
            />
          </Field>
        </FieldGroup>
        {error ? <FieldError>{error}</FieldError> : null}
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create Room'}
        </Button>
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
        <Field>
          <FieldLabel htmlFor="conversation-name">Conversation name</FieldLabel>
          <Input id="conversation-name" name="title" required maxLength={120} autoFocus />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create conversation'}
        </Button>
      </form>
    </ModalDialog>
  )
}
