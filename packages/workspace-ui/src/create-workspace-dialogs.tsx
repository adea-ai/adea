import type { WorkspaceSceneId } from '@adea-ai/types'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Label } from '@adea-ai/ui/components/ui/label'
import { Input } from '@adea-ai/ui/components/ui/input'
import { createSignal, For, Show } from 'solid-js'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@adea-ai/ui/components/ui/alert-dialog'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { ProjectIcon } from './project-icon'

const projectTemplates: readonly Readonly<{ iconKey: string; name: string }>[] = [
  { iconKey: 'study', name: 'Study' },
  { iconKey: 'kitchen', name: 'Kitchen' },
  { iconKey: 'travel', name: 'Travel' },
  { iconKey: 'engineering', name: 'Engineering' },
  { iconKey: 'marketing', name: 'Marketing' },
  { iconKey: 'operations', name: 'Operations' },
  { iconKey: 'gym', name: 'Gym' },
  { iconKey: 'music', name: 'Music' },
  { iconKey: 'garden', name: 'Garden' },
]

export function CreateProjectDialog(props: {
  busy: boolean
  onClose: () => void
  onCreate: (input: Readonly<{ iconKey: string; name: string }>) => Promise<void>
  open: boolean
  template: WorkspaceSceneId
}) {
  const [error, setError] = createSignal<string | null>(null)
  return (
    <ModalDialog
      modal={false}
      class="max-h-full overflow-y-auto"
      open={props.open}
      onClose={props.onClose}
      title="Create Project"
      description="Projects hold the work, Agents, Tasks and conversations of one effort. A repository is optional."
    >
      <div
        class="conventional-template-options"
        aria-label={`${props.template} Project suggestions`}
      >
        <For each={projectTemplates}>
          {(project) => (
            <Button
              type="button"
              variant="outline"
              disabled={props.busy}
              onClick={() =>
                void props
                  .onCreate(project)
                  .then(() => props.onClose())
                  .catch(() => setError('Project could not be created.'))
              }
            >
              <ProjectIcon iconKey={project.iconKey} />
              <strong>{project.name}</strong>
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
            .onCreate(projectFormInputFromForm(form))
            .then(() => props.onClose())
            .catch(() => setError('Project could not be created. Check the fields and retry.'))
        }}
      >
        <div class="flex flex-col gap-5">
          <div class="flex flex-col gap-2">
            <Label for="project-name">Project name</Label>
            <Input id="project-name" name="name" required maxLength={120} />
          </div>
          <div class="flex flex-col gap-2">
            <Label for="project-icon-key">Icon key</Label>
            <Input
              id="project-icon-key"
              name="iconKey"
              required
              pattern={'[a-z0-9\\-]+'}
              maxLength={80}
            />
          </div>
        </div>
        <Show when={error()}>
          {(message) => (
            <Alert variant="destructive">
              <AlertDescription>{message()}</AlertDescription>
            </Alert>
          )}
        </Show>
        <Button type="submit" disabled={props.busy}>
          {props.busy ? 'Creating…' : 'Create Project'}
        </Button>
      </form>
    </ModalDialog>
  )
}

export const projectIconKeySuggestions = [
  'study',
  'kitchen',
  'travel',
  'engineering',
  'marketing',
  'operations',
] as const

export function projectFormInputFromForm(
  form: FormData
): Readonly<{ iconKey: string; name: string }> {
  return {
    iconKey: String(form.get('iconKey') ?? ''),
    name: String(form.get('name') ?? ''),
  }
}

export function EditProjectDialog(props: {
  busy: boolean
  initialIconKey: string
  initialName: string
  onClose: () => void
  onSave: (input: Readonly<{ iconKey: string; name: string }>) => Promise<void>
  open: boolean
  projectName: string
}) {
  const [error, setError] = createSignal<string | null>(null)
  return (
    <ModalDialog
      modal={false}
      class="max-h-full overflow-y-auto"
      open={props.open}
      onClose={props.onClose}
      title={`Edit ${props.projectName}`}
      description="Rename the Project or change its icon key to update its sidebar icon."
    >
      <form
        class="conventional-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          setError(null)
          void props
            .onSave(projectFormInputFromForm(form))
            .then(() => props.onClose())
            .catch(() => setError('Project could not be updated. Check the fields and retry.'))
        }}
      >
        <div class="flex flex-col gap-5">
          <div class="flex flex-col gap-2">
            <Label for="edit-project-name">Project name</Label>
            <Input
              id="edit-project-name"
              name="name"
              required
              maxLength={120}
              value={props.initialName}
            />
          </div>
          <div class="flex flex-col gap-2">
            <Label for="edit-project-icon-key">Icon key</Label>
            <Input
              id="edit-project-icon-key"
              name="iconKey"
              required
              pattern={'[a-z0-9\\-]+'}
              maxLength={80}
              value={props.initialIconKey}
              suggestions={projectIconKeySuggestions}
            />
          </div>
        </div>
        <Show when={error()}>
          {(message) => (
            <Alert variant="destructive">
              <AlertDescription>{message()}</AlertDescription>
            </Alert>
          )}
        </Show>
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
  /** The thing being renamed; defaults to a conversation. */
  noun?: 'conversation' | 'task'
}) {
  const [error, setError] = createSignal<string | null>(null)
  const noun = () => props.noun ?? 'conversation'
  return (
    <ModalDialog
      modal={false}
      class="max-h-full overflow-y-auto"
      open={props.open}
      onClose={props.onClose}
      title={`Rename ${noun()}`}
      description={`Give this ${noun()} a clear, durable title.`}
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
            .catch(() =>
              setError(
                noun() === 'task'
                  ? 'Task could not be renamed.'
                  : 'Conversation could not be renamed.'
              )
            )
        }}
      >
        <div class="flex flex-col gap-2">
          <Label for="conversation-title">
            {noun() === 'task' ? 'Task name' : 'Conversation name'}
          </Label>
          <Input
            id="conversation-title"
            name="title"
            required
            maxLength={120}
            autofocus
            value={props.initialTitle}
          />
        </div>
        <Show when={error()}>
          {(message) => (
            <Alert variant="destructive">
              <AlertDescription>{message()}</AlertDescription>
            </Alert>
          )}
        </Show>
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
      modal={false}
      class="max-h-full overflow-y-auto"
      open={props.open}
      onClose={props.onClose}
      title="New group conversation"
      description="A durable conversation for users and multiple Agents, without requiring a Project."
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
        <div class="flex flex-col gap-2">
          <Label for="conversation-name">Conversation name</Label>
          <Input id="conversation-name" name="title" required maxLength={120} autofocus />
        </div>
        <Show when={error()}>
          {(message) => (
            <Alert variant="destructive">
              <AlertDescription>{message()}</AlertDescription>
            </Alert>
          )}
        </Show>
        <Button type="submit" disabled={props.busy}>
          {props.busy ? 'Creating…' : 'Create conversation'}
        </Button>
      </form>
    </ModalDialog>
  )
}

/**
 * A confirmation for an irreversible sidebar action (archive or delete a
 * project, archive a task or conversation). Confirm runs the action and keeps
 * the dialog open with an inline error when it fails. Only Cancel closes it:
 * the shared AlertDialog blocks Escape and outside dismissal by design, so
 * every exit is a named choice.
 */
export function ConfirmActionDialog(props: {
  busy: boolean
  confirmLabel: string
  cancelLabel?: string
  description: string
  destructive?: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
  failure: string
  title: string
}) {
  const [error, setError] = createSignal<string | null>(null)
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <Show when={error()}>
          {(message) => (
            <Alert variant="destructive">
              <AlertDescription>{message()}</AlertDescription>
            </Alert>
          )}
        </Show>
        <AlertDialogFooter>
          <AlertDialogCancel as={Button} type="button" variant="outline">
            {props.cancelLabel ?? 'Cancel'}
          </AlertDialogCancel>
          <Button
            type="button"
            variant={props.destructive ? 'destructive' : 'default'}
            disabled={props.busy}
            onClick={() => {
              setError(null)
              void props
                .onConfirm()
                .then(() => props.onClose())
                .catch(() => setError(props.failure))
            }}
          >
            {props.busy ? 'Working…' : props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
