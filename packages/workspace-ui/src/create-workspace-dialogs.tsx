import type { WorkspaceAccentId } from '@adea-ai/types'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Label } from '@adea-ai/ui/components/ui/label'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Text } from '@adea-ai/ui/components/ui/typography'
import {
  DEFAULT_PROJECT_ICON_KEY,
  ProjectIdentityFields,
} from '@adea-ai/workspace-nav/project-identity-fields'
import {
  describeWorkspaceCreationContext,
  type WorkspaceCreationContext,
} from '@adea-ai/workspace-nav/workspace-nav'
import { createSignal, Show, type ComponentProps } from 'solid-js'
import type { DevProjectFlow } from './create-project-flow'

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

/** What the project dialogs hand their host: the shared identity of one project. */
export type ProjectIdentityInput = Readonly<{
  accent: WorkspaceAccentId | null
  iconKey: string
  name: string
}>

function ProjectIdentityForm(props: {
  busy: boolean
  initial: ProjectIdentityInput
  submitLabel: string
  busyLabel: string
  failure: string
  note?: string
  onSubmit: (input: ProjectIdentityInput) => Promise<void>
  onDone: () => void
}) {
  const [name, setName] = createSignal(props.initial.name)
  const [iconKey, setIconKey] = createSignal(props.initial.iconKey)
  const [accent, setAccent] = createSignal<WorkspaceAccentId | null>(props.initial.accent)
  const [error, setError] = createSignal<string | null>(null)
  return (
    <form
      class="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (name().trim() === '') return
        setError(null)
        void props
          .onSubmit({ accent: accent(), iconKey: iconKey(), name: name().trim() })
          .then(() => props.onDone())
          .catch(() => setError(props.failure))
      }}
    >
      <ProjectIdentityFields
        autofocus
        name={name()}
        onNameChange={setName}
        iconKey={iconKey()}
        onIconKeyChange={setIconKey}
        accent={accent()}
        onAccentChange={(value) => setAccent(value as WorkspaceAccentId | null)}
      />
      <Show when={props.note}>
        {(note) => (
          <Text variant="caption" tone="muted">
            {note()}
          </Text>
        )}
      </Show>
      <Show when={error()}>
        {(message) => (
          <Alert variant="destructive">
            <AlertDescription>{message()}</AlertDescription>
          </Alert>
        )}
      </Show>
      <Button type="submit" disabled={props.busy || name().trim() === ''}>
        {props.busy ? props.busyLabel : props.submitLabel}
      </Button>
    </form>
  )
}

export function CreateProjectDialog(props: {
  busy: boolean
  onClose: () => void
  onCreate: (input: ProjectIdentityInput) => Promise<void>
  open: boolean
}) {
  return (
    <ModalDialog
      modal={false}
      class="max-h-full overflow-y-auto"
      open={props.open}
      onClose={props.onClose}
      title="Add project"
      description="A project holds the sessions, Agents and conversations of one effort. A repository is optional."
    >
      <ProjectIdentityForm
        busy={props.busy}
        initial={{ accent: null, iconKey: DEFAULT_PROJECT_ICON_KEY, name: '' }}
        submitLabel="Add project"
        busyLabel="Adding…"
        failure="Project could not be added. Check the fields and retry."
        onSubmit={props.onCreate}
        onDone={props.onClose}
      />
    </ModalDialog>
  )
}

/**
 * A new workspace needs only a name; its icon and colour are customised from
 * its settings once it exists. The context line states owner, initial audience
 * and placement from existing contracts, so nothing is granted implicitly.
 */
export function CreateWorkspaceDialog(props: {
  busy: boolean
  context?: WorkspaceCreationContext
  onClose: () => void
  onCreate: (name: string) => Promise<void>
  open: boolean
}) {
  const [name, setName] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  return (
    <ModalDialog
      modal={false}
      class="max-h-full overflow-y-auto"
      open={props.open}
      onClose={props.onClose}
      title="New workspace"
      description={describeWorkspaceCreationContext(props.context)}
    >
      <form
        class="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          const value = name().trim()
          if (value === '' || props.busy) return
          setError(null)
          void props
            .onCreate(value)
            .then(() => props.onClose())
            .catch(() => setError('Workspace could not be created. Try again.'))
        }}
      >
        <div class="flex flex-col gap-2">
          <Label for="new-workspace-name">Workspace name</Label>
          <Input
            id="new-workspace-name"
            name="name"
            required
            maxLength={80}
            autofocus
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </div>
        <Show when={error()}>
          {(message) => (
            <Alert variant="destructive">
              <AlertDescription>{message()}</AlertDescription>
            </Alert>
          )}
        </Show>
        <Button type="submit" disabled={props.busy || name().trim() === ''}>
          {props.busy ? 'Creating…' : 'Create workspace'}
        </Button>
      </form>
    </ModalDialog>
  )
}

/**
 * A project's settings in the cloud: its name, icon and icon colour, shared by
 * every member. The directory a project works in and its default harness and
 * model belong to the device that runs it, so they are set from the desktop
 * app; nothing here changes how a session runs.
 */
export function ProjectSettingsDialog(props: {
  busy: boolean
  initial: ProjectIdentityInput
  onClose: () => void
  onSave: (input: ProjectIdentityInput) => Promise<void>
  open: boolean
}) {
  return (
    <ModalDialog
      modal={false}
      class="max-h-full overflow-y-auto"
      open={props.open}
      onClose={props.onClose}
      title={`${props.initial.name} settings`}
      description="How this project looks in the sidebar for everyone in the workspace."
    >
      <ProjectIdentityForm
        busy={props.busy}
        initial={props.initial}
        submitLabel="Save changes"
        busyLabel="Saving…"
        failure="Project could not be updated. Check the fields and retry."
        note="The project's directory and its default harness and model are device settings; change them in the desktop app. Saving here never changes how a session runs."
        onSubmit={props.onSave}
        onDone={props.onClose}
      />
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
        class="grid gap-4"
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

// The group dialogs live with the group audience flow; this module is the one place that loads them.
export { ConnectedCreateGroupDialog, CreateGroupDialog, GroupManageDialog } from './group-audience'

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

/** Shared lazy routing keeps the detailed form out of both eager sidebar graphs. */
export function ProjectCreateDialog(
  props: Omit<ComponentProps<typeof CreateProjectDialog>, 'open'> & {
    createProjectFlow?: () => DevProjectFlow | undefined
    workspace: { name: string }
    onImported(): void
  }
) {
  // Sample once as the lazy dialog opens; later project-list updates cannot
  // replace its scope or discard the form's draft state.
  const projectFlow = props.createProjectFlow?.()
  return (
    <Show
      when={projectFlow}
      fallback={
        <CreateProjectDialog
          busy={props.busy}
          onClose={props.onClose}
          onCreate={props.onCreate}
          open
        />
      }
    >
      {(flow) =>
        flow().renderDialog({
          flow: flow(),
          workspaceName: props.workspace.name,
          onImported: props.onImported,
          onClose: () => {
            props.onClose()
            props.onImported()
          },
        })
      }
    </Show>
  )
}
