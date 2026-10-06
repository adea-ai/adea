/*
 * The Dev sidebar's small dialogs (ADR 0011), loaded on first use: naming a
 * worktree, project or branch, confirming archive and delete with the exact
 * cleanup plan, project settings with the repository registry, and adding a
 * repository to a project. Composed only from published primitives; the
 * runtime and cloud calls arrive as callbacks.
 */
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@adea-ai/ui/components/ui/alert-dialog'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { Heading, Text } from '@adea-ai/ui/components/ui/typography'
import { For, Show, Suspense, createSignal, createUniqueId, lazy } from 'solid-js'

import type { DevProjectNames } from '../platform'
import { AddProjectForm } from './add-project-form'

const RepoRegistryPanel = lazy(() =>
  import('./repo-registry-panel').then((module) => ({ default: module.RepoRegistryPanel }))
)

/** A failure message, or undefined on success (the dialog then closes). */
type Outcome = Promise<string | undefined>

function ErrorAlert(props: { message: string | undefined }) {
  return (
    <Show when={props.message}>
      {(message) => (
        <Alert variant="destructive">
          <AlertDescription>{message()}</AlertDescription>
        </Alert>
      )}
    </Show>
  )
}

/** One required text field: a worktree title, a project name, or a branch name. */
export function DevNameDialog(props: {
  title: string
  description: string
  label: string
  initialValue?: string
  placeholder?: string
  confirmLabel: string
  /** Allow an empty value (clearing a title). */
  allowEmpty?: boolean
  maxLength?: number
  onSubmit: (value: string) => Outcome
  onClose: () => void
}) {
  const [value, setValue] = createSignal(props.initialValue ?? '')
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const inputId = `dev-name-dialog-${createUniqueId()}`
  const ready = () => props.allowEmpty || value().trim() !== ''
  return (
    <ModalDialog open onClose={props.onClose} title={props.title} description={props.description}>
      <form
        class="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (!ready() || busy()) return
          setBusy(true)
          setError(undefined)
          void props.onSubmit(value().trim()).then((failure) => {
            setBusy(false)
            if (failure) setError(failure)
            else props.onClose()
          })
        }}
      >
        <div class="flex flex-col gap-2">
          <Label for={inputId}>{props.label}</Label>
          <Input
            id={inputId}
            value={value()}
            placeholder={props.placeholder}
            maxLength={props.maxLength ?? 120}
            autofocus
            onInput={(event) => setValue(event.currentTarget.value)}
          />
        </div>
        <ErrorAlert message={error()} />
        <Button type="submit" disabled={busy() || !ready()}>
          {busy() ? 'Working…' : props.confirmLabel}
        </Button>
      </form>
    </ModalDialog>
  )
}

/**
 * Archive or delete confirmation. `steps` lists what the action will do (a
 * worktree delete names every cleanup step the host planned); a non-empty
 * `blockers` list keeps the action disabled and says why.
 */
export function DevConfirmDialog(props: {
  title: string
  description: string
  steps?: readonly string[]
  blockers?: readonly string[]
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => Outcome
  onClose: () => void
}) {
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const blocked = () => (props.blockers?.length ?? 0) > 0
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
        <Show when={(props.steps?.length ?? 0) > 0}>
          <ol class="flex list-decimal flex-col gap-1 ps-5" aria-label="Planned steps">
            <For each={props.steps}>
              {(step) => (
                <li>
                  <Text variant="label">{step}</Text>
                </li>
              )}
            </For>
          </ol>
        </Show>
        <Show when={blocked()}>
          <Alert variant="destructive">
            <AlertDescription>{props.blockers!.join(' ')}</AlertDescription>
          </Alert>
        </Show>
        <ErrorAlert message={error()} />
        <AlertDialogFooter>
          <AlertDialogCancel as={Button} type="button" variant="outline">
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            variant={props.destructive ? 'destructive' : 'default'}
            disabled={busy() || blocked()}
            onClick={() => {
              setBusy(true)
              setError(undefined)
              void props.onConfirm().then((failure) => {
                setBusy(false)
                if (failure) setError(failure)
                else props.onClose()
              })
            }}
          >
            {busy() ? 'Working…' : props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export type DevRepositoryFlowProps = Readonly<{
  scope: Scope
  execute(command: DevCommand): Promise<DevReply>
  knownProjectNames: readonly string[]
  announce(message: string): void
}>

/**
 * Bind a local repository to one cloud project: authorize a folder, scan it,
 * and import the confirmed entry under the project's own id.
 */
export function DevAddRepositoryDialog(
  props: DevRepositoryFlowProps & {
    projectId: string
    projectName: string
    onImported: () => void
    onClose: () => void
  }
) {
  return (
    <ModalDialog
      open
      onClose={props.onClose}
      title={`Add a repository to ${props.projectName}`}
      description="Authorize a folder on this machine, then import the repository found inside it."
    >
      <div class="flex flex-col gap-3">
        <AddProjectForm
          scope={props.scope}
          execute={props.execute}
          knownProjectNames={props.knownProjectNames}
          announce={props.announce}
          mintProjectId={() => props.projectId}
          onImported={() => {
            props.onImported()
            props.onClose()
          }}
        />
      </div>
    </ModalDialog>
  )
}

/**
 * The workspace header's "New project": name the cloud project first, then
 * optionally bind a local repository to it. Without a cloud host the dialog
 * goes straight to the repository step and the import mints the id.
 */
export function DevNewProjectDialog(
  props: DevRepositoryFlowProps & {
    workspaceName: string
    onCreateProject?: (name: string) => Promise<string>
    onImported: (projectId: string | undefined) => void
    onClose: () => void
  }
) {
  const [projectId, setProjectId] = createSignal<string | undefined>()
  const [name, setName] = createSignal('')
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const inputId = `dev-new-project-${createUniqueId()}`
  const naming = () => Boolean(props.onCreateProject) && projectId() === undefined
  return (
    <ModalDialog
      open
      onClose={props.onClose}
      title={`New project in ${props.workspaceName}`}
      description={
        naming()
          ? 'Name the project. You can add a local repository next, or later from its menu.'
          : 'Authorize a folder on this machine, then import the repository found inside it.'
      }
    >
      <Show
        when={naming()}
        fallback={
          <div class="flex flex-col gap-3">
            <AddProjectForm
              scope={props.scope}
              execute={props.execute}
              knownProjectNames={props.knownProjectNames}
              announce={props.announce}
              {...(projectId() ? { mintProjectId: () => projectId()! } : {})}
              onImported={() => {
                props.onImported(projectId())
                props.onClose()
              }}
            />
            <Show when={projectId()}>
              <Button type="button" variant="outline" onClick={() => props.onClose()}>
                Skip for now
              </Button>
            </Show>
          </div>
        }
      >
        <form
          class="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            const value = name().trim()
            if (!value || busy() || !props.onCreateProject) return
            setBusy(true)
            setError(undefined)
            props
              .onCreateProject(value)
              .then((id) => {
                setProjectId(id)
                props.onImported(undefined)
              })
              .catch(() => setError('The project could not be created. Try again.'))
              .finally(() => setBusy(false))
          }}
        >
          <div class="flex flex-col gap-2">
            <Label for={inputId}>Project name</Label>
            <Input
              id={inputId}
              value={name()}
              maxLength={120}
              autofocus
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </div>
          <ErrorAlert message={error()} />
          <Button type="submit" disabled={busy() || name().trim() === ''}>
            {busy() ? 'Creating…' : 'Create project'}
          </Button>
        </form>
      </Show>
    </ModalDialog>
  )
}

/**
 * Project settings: the cloud name (when the host can rename) and the local
 * repositories the binding holds, through the repository registry.
 */
export function DevProjectSettingsDialog(
  props: DevRepositoryFlowProps & {
    projectId: string
    projectName: string
    bound: boolean
    projectNames?: DevProjectNames
    onRename?: (name: string) => Outcome
    onAddRepository: () => void
    onClose: () => void
  }
) {
  const [name, setName] = createSignal(props.projectName)
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const inputId = `dev-project-settings-${createUniqueId()}`
  return (
    <ModalDialog
      open
      size="settings"
      class="conventional-settings-dialog"
      onClose={props.onClose}
      title={`${props.projectName} settings`}
      description="The project's name and the local repositories bound to it on this device."
    >
      <div class="flex flex-col gap-6">
        <Show when={props.onRename}>
          <form
            class="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              const value = name().trim()
              if (!value || busy()) return
              setBusy(true)
              setError(undefined)
              void props.onRename!(value).then((failure) => {
                setBusy(false)
                setError(failure)
              })
            }}
          >
            <div class="flex flex-col gap-2">
              <Label for={inputId}>Project name</Label>
              <Input
                id={inputId}
                value={name()}
                maxLength={120}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </div>
            <ErrorAlert message={error()} />
            <Button type="submit" disabled={busy() || name().trim() === ''}>
              {busy() ? 'Saving…' : 'Save name'}
            </Button>
          </form>
        </Show>
        <section class="flex flex-col gap-3" aria-label="Repositories">
          <Heading as="h3" size="subsection">
            Repositories
          </Heading>
          <Show
            when={props.bound}
            fallback={
              <div class="flex flex-col gap-2">
                <Text variant="caption" tone="muted">
                  No local repository is bound to this project on this device.
                </Text>
                <Button type="button" variant="outline" onClick={() => props.onAddRepository()}>
                  Add repository…
                </Button>
              </div>
            }
          >
            <Suspense
              fallback={
                <Text variant="caption" tone="muted">
                  Loading repositories…
                </Text>
              }
            >
              <RepoRegistryPanel
                scope={props.scope}
                execute={props.execute}
                announce={props.announce}
                projectNames={props.projectNames}
              />
            </Suspense>
          </Show>
        </section>
      </div>
    </ModalDialog>
  )
}
