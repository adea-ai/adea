import '../../src/start/globals.css'
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'
import { render } from 'solid-js/web'
import { createSignal, onMount } from 'solid-js'

// The Dev view's Repositories panel rides its own lazy chunk; the harness
// mounts it directly over a deterministic registry: one adopted repository
// with a GitHub remote, one managed clone, and one binding-only row (import
// minted the binding, no record yet).
import { RepoRegistryPanel } from '../../../../packages/dev-view/src/sidebar/repo-registry-panel'

const scope: Scope = {
  accountId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  runtimeNodeId: '33333333-3333-4333-8333-333333333333',
}

const ADOPTED_ID = '44444444-4444-4444-8444-444444444444'
const MANAGED_ID = '55555555-5555-4555-8555-555555555555'
const BINDING_ONLY_ID = '66666666-6666-4666-8666-666666666666'
const PROJECT_ID = '77777777-7777-4777-8777-777777777777'
const BOOKMARK_ID = '88888888-8888-4888-8888-888888888888'

const params = new URLSearchParams(location.search)
/** Pin the panel's typed-refusal path end to end. */
const refuseRemove = params.get('refuse') === 'remove'

function Harness() {
  const [ready, setReady] = createSignal(false)
  const [operations, setOperations] = createSignal<string[]>([])
  const [announcement, setAnnouncement] = createSignal('')
  // The durable registry the fake runtime serves; removal drops the record,
  // re-adopting restores it — so the panel's reload observes real moves.
  const [records, setRecords] = createSignal<Record<string, unknown>[]>([
    {
      id: ADOPTED_ID,
      scope,
      kind: 'git',
      lifecycle: 'ready',
      canonicalRoot: '/work/adea',
      remote: {
        provider: 'github',
        host: 'github.com',
        ownerPath: 'adea-ai',
        displayUrl: 'https://github.com/adea-ai/adea',
      },
      defaultRef: 'refs/heads/main',
      projectIds: [PROJECT_ID],
      version: 3,
    },
    {
      id: MANAGED_ID,
      scope,
      kind: 'git',
      lifecycle: 'ready',
      layout: 'bare_managed',
      canonicalRoot: '/managed/repo.git',
      projectIds: [PROJECT_ID],
      version: 1,
    },
  ])
  const execute = async (command: DevCommand): Promise<DevReply> => {
    setOperations((current) => [...current, command.operation])
    const body = command.body as Record<string, unknown>
    switch (command.operation) {
      case 'dev.project.list':
        return ok(command, {
          items: [
            {
              id: PROJECT_ID,
              scope,
              repoIds: [ADOPTED_ID, MANAGED_ID, BINDING_ONLY_ID],
              repos: [
                {
                  repoId: ADOPTED_ID,
                  rootBookmarkId: BOOKMARK_ID,
                  canonicalRoot: '/work/adea',
                },
                // A managed bare clone's binding carries `layout` and no
                // bookmark.
                {
                  repoId: MANAGED_ID,
                  canonicalRoot: '/managed/repo.git',
                  layout: 'bare_managed',
                },
                {
                  repoId: BINDING_ONLY_ID,
                  rootBookmarkId: BOOKMARK_ID,
                  canonicalRoot: '/work/adopted',
                },
              ],
              lifecycle: 'ready',
              version: 1,
            },
          ],
        })
      case 'dev.repo.list':
        return ok(command, { items: records() })
      case 'dev.project.bookmarks':
        return ok(command, {
          items: [
            {
              id: BOOKMARK_ID,
              scope,
              label: 'Work',
              kind: 'repository',
              canonicalRoot: '/work',
              rootIdentity: { mtimeNs: '1', size: '2' },
              state: 'active',
              generation: 1,
              version: 1,
            },
          ],
        })
      case 'dev.repo.credentialRefs':
        return ok(command, { items: [] })
      case 'dev.repo.remove': {
        const repoId = String(body.repoId)
        if (refuseRemove) return fail(command, 'stale_version', 'repository moved on: version 3')
        const current = records().find((entry) => entry.id === repoId)
        if (!current) return fail(command, 'not_found', 'repository is not registered')
        if (current.version !== body.expectedVersion)
          return fail(command, 'stale_version', 'repository moved on')
        setRecords((entries) => entries.filter((entry) => entry.id !== repoId))
        return ok(command, current)
      }
      case 'dev.repo.adopt': {
        const repoId = String(body.repoId)
        if (records().some((entry) => entry.id === repoId))
          return fail(command, 'stale_version', 'repository moved on')
        const adopted = {
          id: repoId,
          scope,
          kind: 'git',
          lifecycle: 'ready',
          canonicalRoot: '/work/adopted',
          projectIds: [PROJECT_ID],
          version: 1,
        }
        setRecords((entries) => [...entries, adopted])
        return ok(command, adopted)
      }
      default:
        return fail(command, 'unsupported_capability', `no handler for ${command.operation}`)
    }
  }

  onMount(() => setReady(true))
  return (
    <main>
      <RepoRegistryPanel scope={scope} execute={execute} announce={setAnnouncement} />
      <output data-testid="ready">{ready() ? 'ready' : 'mounting'}</output>
      <output data-testid="operations">{JSON.stringify(operations())}</output>
      <output data-testid="announcement">{announcement()}</output>
    </main>
  )
}

function ok(command: DevCommand, value: unknown): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    value,
    observedAt: new Date().toISOString(),
  }
}

function fail(command: DevCommand, code: string, message: string): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: false,
    error: { code, retryable: false, message },
    observedAt: new Date().toISOString(),
  }
}

render(() => <Harness />, document.getElementById('harness-root')!)
