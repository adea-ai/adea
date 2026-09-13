import type { WorkspaceSceneId } from '@adea-ai/types'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@adea-ai/ui/components/ui/field'
import { Input } from '@adea-ai/ui/components/ui/input'
import { createSignal, For, Show } from 'solid-js'

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

export function CreateRoomDialog(props: {
  busy: boolean
  onClose: () => void
  onCreate: (input: Readonly<{ functionKey: string; name: string }>) => Promise<void>
  open: boolean
  template: WorkspaceSceneId
}) {
  const [error, setError] = createSignal<string | null>(null)
  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title="Create Room"
      description="Rooms are the primary functional contexts in Adea."
    >
      <div class="conventional-template-options" aria-label={`${props.template} Room suggestions`}>
        <For each={roomTemplates}>
          {(room) => (
            <Button
              type="button"
              variant="outline"
              disabled={props.busy}
              onClick={() =>
                void props
                  .onCreate(room)
                  .then(() => props.onClose())
                  .catch(() => setError('Room could not be created.'))
              }
            >
              <RoomIcon functionKey={room.functionKey} />
              <strong>{room.name}</strong>
            </Button>
          )}
        </For>
      </div>
      <form
        class="conventional-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          void props
            .onCreate({
              functionKey: String(form.get('functionKey') ?? ''),
              name: String(form.get('name') ?? ''),
            })
            .then(() => props.onClose())
            .catch(() => setError('Room could not be created. Check the fields and retry.'))
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel for="room-name">Room name</FieldLabel>
            <Input id="room-name" name="name" required maxLength={120} />
          </Field>
          <Field>
            <FieldLabel for="room-function-key">Function key</FieldLabel>
            <Input
              id="room-function-key"
              name="functionKey"
              required
              pattern={'[a-z0-9\\-]+'}
              maxLength={80}
            />
          </Field>
        </FieldGroup>
        <Show when={error()}>{(message) => <FieldError>{message()}</FieldError>}</Show>
        <Button type="submit" disabled={props.busy}>
          {props.busy ? 'Creating…' : 'Create Room'}
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

export function EditRoomDialog(props: {
  busy: boolean
  initialFunctionKey: string
  initialName: string
  onClose: () => void
  onSave: (input: Readonly<{ functionKey: string; name: string }>) => Promise<void>
  open: boolean
  roomName: string
}) {
  const [error, setError] = createSignal<string | null>(null)
  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title={`Edit ${props.roomName}`}
      description="Rename the Room or change its function key to update its sidebar icon."
    >
      <form
        class="conventional-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          setError(null)
          void props
            .onSave({
              functionKey: String(form.get('functionKey') ?? ''),
              name: String(form.get('name') ?? ''),
            })
            .then(() => props.onClose())
            .catch(() => setError('Room could not be updated. Check the fields and retry.'))
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel for="edit-room-name">Room name</FieldLabel>
            <Input
              id="edit-room-name"
              name="name"
              required
              maxLength={120}
              value={props.initialName}
            />
          </Field>
          <Field>
            <FieldLabel for="edit-room-function-key">Function key</FieldLabel>
            <Input
              id="edit-room-function-key"
              name="functionKey"
              required
              pattern={'[a-z0-9\\-]+'}
              maxLength={80}
              value={props.initialFunctionKey}
              list="edit-room-function-keys"
            />
            <datalist id="edit-room-function-keys">
              <For each={roomFunctionKeySuggestions}>{(key) => <option value={key} />}</For>
            </datalist>
          </Field>
        </FieldGroup>
        <Show when={error()}>{(message) => <FieldError>{message()}</FieldError>}</Show>
        <Button type="submit" disabled={props.busy}>
          {props.busy ? 'Saving…' : 'Save changes'}
        </Button>
      </form>
    </ModalDialog>
  )
}

export function RenameConversationDialog(props: {
  busy: boolean
  initialTitle: string
  onClose: () => void
  onSave: (title: string) => Promise<void>
  open: boolean
}) {
  const [error, setError] = createSignal<string | null>(null)
  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title="Rename conversation"
      description="Give this conversation a clear, durable title."
    >
      <form
        class="conventional-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          const title = String(new FormData(event.currentTarget).get('title') ?? '')
          setError(null)
          void props
            .onSave(title)
            .then(() => props.onClose())
            .catch(() => setError('Conversation could not be renamed.'))
        }}
      >
        <Field>
          <FieldLabel for="conversation-title">Conversation name</FieldLabel>
          <Input
            id="conversation-title"
            name="title"
            required
            maxLength={120}
            autofocus
            value={props.initialTitle}
          />
        </Field>
        <Show when={error()}>{(message) => <FieldError>{message()}</FieldError>}</Show>
        <Button type="submit" disabled={props.busy}>
          {props.busy ? 'Saving…' : 'Save title'}
        </Button>
      </form>
    </ModalDialog>
  )
}

export function CreateGroupDialog(props: {
  busy: boolean
  onClose: () => void
  onCreate: (title: string) => Promise<void>
  open: boolean
}) {
  const [error, setError] = createSignal<string | null>(null)
  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title="New group conversation"
      description="A durable conversation for users and multiple Agents, without requiring a Room."
    >
      <form
        class="conventional-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          const title = String(new FormData(event.currentTarget).get('title') ?? '')
          void props
            .onCreate(title)
            .then(() => props.onClose())
            .catch(() => setError('Group conversation could not be created.'))
        }}
      >
        <Field>
          <FieldLabel for="conversation-name">Conversation name</FieldLabel>
          <Input id="conversation-name" name="title" required maxLength={120} autofocus />
        </Field>
        <Show when={error()}>{(message) => <FieldError>{message()}</FieldError>}</Show>
        <Button type="submit" disabled={props.busy}>
          {props.busy ? 'Creating…' : 'Create conversation'}
        </Button>
      </form>
    </ModalDialog>
  )
}
