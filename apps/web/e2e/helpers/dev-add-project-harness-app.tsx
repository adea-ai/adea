import '../../src/start/globals.css'
import type { DevCommand, DevReply } from '@adea-ai/types/dev-runtime'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Show, Suspense, createSignal, lazy, onMount, onCleanup } from 'solid-js'
import { render } from 'solid-js/web'

// The Dev sidebar opens this dialog from a project's "Add repository…" item
// (and the "New project" flow); the form loads with the dialog.
const DevAddRepositoryDialog = lazy(() =>
  import('../../../../packages/dev-view/src/sidebar/dev-nav-dialogs').then((module) => ({
    default: module.DevAddRepositoryDialog,
  }))
)

const ProjectCreateDialog = lazy(() =>
  import('../../../../packages/workspace-ui/src/create-workspace-dialogs').then((module) => ({
    default: module.ProjectCreateDialog,
  }))
)

const DevNewProjectDialog = lazy(() =>
  import('../../../../packages/dev-view/src/sidebar/dev-nav-dialogs').then((module) => ({
    default: module.DevNewProjectDialog,
  }))
)

/** The cloud project the dialog binds; the register never mints one itself. */
const PROJECT_ID = '0d9e4f1a-1111-4000-8000-00000000c10d'

function Harness() {
  const [ready, setReady] = createSignal(false)
  const [knownNames, setKnownNames] = createSignal<string[]>([])
  const [operations, setOperations] = createSignal<string[]>([])
  const [announcement, setAnnouncement] = createSignal('')
  const [imports, setImports] = createSignal(0)
  const [authorized, setAuthorized] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  const [newProjectOpen, setNewProjectOpen] = createSignal(false)
  const [createdNames, setCreatedNames] = createSignal<string[]>([])
  const [cloneBodies, setCloneBodies] = createSignal<Record<string, unknown>[]>([])
  const [refreshes, setRefreshes] = createSignal(0)
  const [pickerCalls, setPickerCalls] = createSignal(0)
  const [importedIds, setImportedIds] = createSignal<string[]>([])
  const execute = async (command: DevCommand): Promise<DevReply> => {
    setOperations((current) => [...current, command.operation])
    if (
      command.operation === 'dev.project.authorizeRoot' &&
      (command.body as { absolutePath?: string }).absolutePath === '/etc/disallowed'
    ) {
      return {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: false,
        error: {
          code: 'unauthorized_root',
          retryable: false,
          message: '/etc/disallowed is not authorized for import',
        },
      }
    }
    let value: unknown
    switch (command.operation) {
      case 'dev.project.bookmarks':
        value = {
          items: [
            {
              id: 'root',
              label: 'Work',
              kind: 'directory',
              canonicalRoot: '/srv/work',
              state: 'active',
            },
            ...(authorized()
              ? [
                  {
                    id: 'authorized',
                    label: 'Checkout',
                    kind: 'repository',
                    canonicalRoot: '/srv/checkout',
                    state: 'active',
                  },
                ]
              : []),
          ],
        }
        break
      case 'dev.project.authorizeRoot':
        setAuthorized(true)
        value = {
          id: 'authorized',
          label: 'Checkout',
          kind: 'repository',
          canonicalRoot: '/srv/checkout',
          state: 'active',
        }
        break
      case 'dev.project.scan':
        value = {
          rootBookmarkId: command.body.rootBookmarkId === 'authorized' ? 'authorized' : 'root',
          items: [
            {
              name: 'Fixture project',
              relativeDir: 'apps/fixture',
              manifestPath: 'apps/fixture/package.json',
              packageManager: 'bun',
              languages: ['typescript'],
              suggestedScripts: [],
              diagnostics: [],
            },
          ],
          diagnostics: [],
        }
        break
      case 'dev.github.repositories':
        value = [
          {
            nameWithOwner: 'fixture/repository',
            url: 'https://github.com/fixture/repository',
            visibility: 'private',
            updatedAt: '2026-10-07T00:00:00Z',
            isFork: false,
          },
        ]
        break
      case 'dev.project.clone':
        setCloneBodies((current) => [...current, command.body as Record<string, unknown>])
        value = { id: command.body.projectId }
        break
      case 'dev.project.import': {
        // The import binds a client-minted cloud project id; the register
        // takes no name and no groups.
        const body = command.body as Record<string, unknown>
        if (
          typeof body.projectId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.projectId) ||
          Object.keys(body).toSorted().join(',') !== 'projectId,rootBookmarkId'
        )
          throw new Error('Unexpected import body: ' + JSON.stringify(body))
        setImportedIds((current) => [...current, body.projectId as string])
        value = { id: body.projectId }
        break
      }
      default:
        throw new Error('Unexpected fixture operation: ' + command.operation)
    }
    return {
      schemaVersion: 1,
      operation: command.operation,
      requestId: command.requestId,
      ok: true,
      value,
    }
  }
  const refreshKnownNames = () => setKnownNames(['Another project'])
  onMount(() => {
    window.addEventListener('project-list-refresh', refreshKnownNames)
    setReady(true)
  })
  onCleanup(() => window.removeEventListener('project-list-refresh', refreshKnownNames))
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Add repository…
      </Button>
      <Button type="button" onClick={() => setNewProjectOpen(true)}>
        New project
      </Button>
      <Suspense fallback={null}>
        <Show when={open()}>
          <DevAddRepositoryDialog
            scope={{ accountId: 'account', workspaceId: 'workspace', runtimeNodeId: 'node' }}
            execute={execute}
            knownProjectNames={[]}
            projectId={PROJECT_ID}
            projectName="Fixture project"
            onImported={() => setImports((current) => current + 1)}
            onClose={() => setOpen(false)}
            announce={setAnnouncement}
          />
        </Show>
        <Show when={newProjectOpen()}>
          <ProjectCreateDialog
            busy={false}
            onCreate={async ({ name }) => {
              setCreatedNames((current) => [...current, name])
            }}
            createProjectFlow={() =>
              (window as unknown as { basic?: boolean }).basic
                ? undefined
                : {
                    renderDialog: (dialog) => (
                      <DevNewProjectDialog
                        scope={dialog.flow.scope}
                        execute={dialog.flow.execute}
                        knownProjectNames={dialog.flow.knownProjectNames}
                        announce={setAnnouncement}
                        {...(dialog.flow.pickFolder ? { pickFolder: dialog.flow.pickFolder } : {})}
                        workspaceName={dialog.workspaceName}
                        onCreateProject={dialog.flow.onCreateProject}
                        onImported={dialog.onImported}
                        onClose={dialog.onClose}
                      />
                    ),
                    scope: {
                      accountId: 'account',
                      workspaceId: 'workspace',
                      runtimeNodeId: 'node',
                    },
                    execute,
                    knownProjectNames: knownNames(),
                    onCreateProject: async (name) => {
                      setCreatedNames((current) => [...current, name])
                      return PROJECT_ID
                    },
                    pickFolder: async () => {
                      setPickerCalls((current) => current + 1)
                      return (window as unknown as { cancelPicker?: boolean }).cancelPicker
                        ? null
                        : '/srv/checkout'
                    },
                  }
            }
            workspace={{ name: 'Fixture workspace', scene: 'work' }}
            onImported={() => setRefreshes((current) => current + 1)}
            onClose={() => setNewProjectOpen(false)}
          />
        </Show>
      </Suspense>
      <output data-testid="known-names">{JSON.stringify(knownNames())}</output>
      <output data-testid="created-names">{JSON.stringify(createdNames())}</output>
      <output data-testid="clone-bodies">{JSON.stringify(cloneBodies())}</output>
      <output data-testid="refreshes">{refreshes()}</output>
      <output data-testid="picker-calls">{pickerCalls()}</output>
      <output data-testid="ready">{ready() ? 'ready' : 'mounting'}</output>
      <output data-testid="operations">{JSON.stringify(operations())}</output>
      <output data-testid="announcement">{announcement()}</output>
      <output data-testid="imports">{imports()}</output>
      <output data-testid="imported-ids">{JSON.stringify(importedIds())}</output>
    </>
  )
}

render(() => <Harness />, document.getElementById('harness-root')!)
