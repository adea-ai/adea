import '../../src/start/globals.css'
import type { DevCommand, DevReply } from '@adea-ai/types/dev-runtime'
import { createSignal, onMount } from 'solid-js'
import { render } from 'solid-js/web'
import { AddProjectPanel } from '../../../../packages/dev-view/src/sidebar/add-project-panel'

function Harness() {
  const [ready, setReady] = createSignal(false)
  const [operations, setOperations] = createSignal<string[]>([])
  const [announcement, setAnnouncement] = createSignal('')
  const [imports, setImports] = createSignal(0)
  const [authorized, setAuthorized] = createSignal(false)
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
  onMount(() => setReady(true))
  return (
    <>
      <AddProjectPanel
        scope={{ accountId: 'account', workspaceId: 'workspace', runtimeNodeId: 'node' }}
        execute={execute}
        knownProjectNames={[]}
        onImported={() => setImports((current) => current + 1)}
        announce={setAnnouncement}
      />
      <output data-testid="ready">{ready() ? 'ready' : 'mounting'}</output>
      <output data-testid="operations">{JSON.stringify(operations())}</output>
      <output data-testid="announcement">{announcement()}</output>
      <output data-testid="imports">{imports()}</output>
    </>
  )
}

render(() => <Harness />, document.getElementById('harness-root')!)
