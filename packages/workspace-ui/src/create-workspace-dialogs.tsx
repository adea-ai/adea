import { useState } from 'react'
import type { WorkspaceSceneId } from '@agent-hq/types'
import { Button } from '@agent-hq/ui/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@agent-hq/ui/components/ui/field'
import { Input } from '@agent-hq/ui/components/ui/input'

import { ModalDialog } from './modal-dialog'
import { RoomIcon } from './room-icon'

const roomTemplates: readonly Readonly<{ functionKey: string; name: string }>[] = [
  { functionKey: 'study', name: 'Study' },
  { functionKey: 'kitchen', name: 'Kitchen' },
  { functionKey: 'travel', name: 'Travel' },
  { functionKey: 'engineering', name: 'Engineering' },
  { functionKey: 'marketing', name: 'Marketing' },
  { functionKey: 'operations', name: 'Operations' },
  { functionKey: 'gym', name: 'Gym' },
  { functionKey: 'music', name: 'Music' },
  { functionKey: 'garden', name: 'Garden' },
]

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
        {roomTemplates.map((room) => (
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
            <RoomIcon functionKey={room.functionKey} />
            <strong>{room.name}</strong>
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

export const roomFunctionKeySuggestions = [
  'study',
  'kitchen',
  'travel',
  'engineering',
  'marketing',
  'operations',
] as const

export function EditRoomDialog({
  busy,
  initialFunctionKey,
  initialName,
  onClose,
  onSave,
  open,
  roomName,
}: Readonly<{
  busy: boolean
  initialFunctionKey: string
  initialName: string
  onClose: () => void
  onSave: (input: Readonly<{ functionKey: string; name: string }>) => Promise<void>
  open: boolean
  roomName: string
}>) {
  const [error, setError] = useState<string | null>(null)
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={`Edit ${roomName}`}
      description="Rename the Room or change its function key to update its sidebar icon."
    >
      <form
        className="conventional-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          setError(null)
          void onSave({
            functionKey: String(form.get('functionKey') ?? ''),
            name: String(form.get('name') ?? ''),
          })
            .then(onClose)
            .catch(() => setError('Room could not be updated. Check the fields and retry.'))
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="edit-room-name">Room name</FieldLabel>
            <Input
              id="edit-room-name"
              name="name"
              required
              maxLength={120}
              defaultValue={initialName}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-room-function-key">Function key</FieldLabel>
            <Input
              id="edit-room-function-key"
              name="functionKey"
              required
              pattern={'[a-z0-9\\-]+'}
              maxLength={80}
              defaultValue={initialFunctionKey}
              list="edit-room-function-keys"
            />
            <datalist id="edit-room-function-keys">
              {roomFunctionKeySuggestions.map((key) => (
                <option key={key} value={key} />
              ))}
            </datalist>
          </Field>
        </FieldGroup>
        {error ? <FieldError>{error}</FieldError> : null}
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </form>
    </ModalDialog>
  )
}

export function RenameConversationDialog({
  busy,
  initialTitle,
  onClose,
  onSave,
  open,
}: Readonly<{
  busy: boolean
  initialTitle: string
  onClose: () => void
  onSave: (title: string) => Promise<void>
  open: boolean
}>) {
  const [error, setError] = useState<string | null>(null)
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="Rename conversation"
      description="Give this conversation a clear, durable title."
    >
      <form
        className="conventional-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          const title = String(new FormData(event.currentTarget).get('title') ?? '')
          setError(null)
          void onSave(title)
            .then(onClose)
            .catch(() => setError('Conversation could not be renamed.'))
        }}
      >
        <Field>
          <FieldLabel htmlFor="conversation-title">Conversation name</FieldLabel>
          <Input
            id="conversation-title"
            name="title"
            required
            maxLength={120}
            autoFocus
            defaultValue={initialTitle}
          />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save title'}
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
