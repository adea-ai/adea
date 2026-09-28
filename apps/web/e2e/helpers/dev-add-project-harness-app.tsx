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
  const execute = async (command: DevCommand): Promise<DevReply> => {
    setOperations((current) => [...current, command.operation])
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
          ],
        }
        break
      case 'dev.group.list':
        value = { items: [{ id: 'group', name: 'Engineering' }] }
        break
      case 'dev.project.scan':
        value = {
          rootBookmarkId: 'root',
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
      case 'dev.group.create':
        value = { id: 'new-group' }
        break
      case 'dev.project.import':
        value = { id: 'project' }
        break
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
