import '../../src/start/globals.css'
import { ThemeProvider } from '@adea-ai/app-ui/components/theme-provider'
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { WorkspaceDetailsDialog } from '@adea-ai/workspace-ui/workspace-details-dialog'
import { createMemo, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import type { WorkspaceSummary } from '@adea-ai/types'

import {
  createFakeClient,
  createFakeState,
  host,
  key,
  seedHosts,
  type FakeFailure,
  type FakeHost,
  type FakeState,
} from './self-hosted-connection-fixture'

/**
 * Mounts the real Workspace Details dialog, on its Connections section, over an in-page fake of the
 * runtime-node and bootstrap routes. The self-hosted section is mounted exactly as the product
 * mounts it: the dialog hands it the client and workspace id, and the account comes from the shared
 * bootstrap read. `window.selfHostedDetailsHarness` changes the signed-in account (a new client and
 * a cleared cache, as a new session gets), the workspace, the bootstrap answer, or queues failures.
 * Nothing here is a real endpoint or credential.
 */
declare global {
  interface Window {
    selfHostedDetailsHarness: {
      state: FakeState
      register: (partial: Partial<FakeHost> & Pick<FakeHost, 'id' | 'displayName'>) => void
      revokeExternally: (hostId: string) => void
      setAccount: (account: string) => void
      setWorkspace: (workspace: string) => void
      setBootstrap: (mode: FakeState['bootstrap']) => void
      queueListFailure: (failure: FakeFailure) => void
    }
  }
}

const root = document.querySelector('#harness-root')!
const state = createFakeState(seedHosts())
state.bootstrap =
  (root.getAttribute('data-bootstrap') as FakeState['bootstrap'] | null) ?? 'account'

const [account, setAccount] = createSignal(state.account)
const [workspaceId, setWorkspaceId] = createSignal(state.workspace)

window.selfHostedDetailsHarness = {
  state,
  register: (partial) => {
    state.hosts[key(state)] = [...(state.hosts[key(state)] ?? []), host(partial)]
  },
  revokeExternally: (hostId) => {
    const item = (state.hosts[key(state)] ?? []).find((candidate) => candidate.id === hostId)
    if (item) item.pairingState = 'revoked'
  },
  setAccount: (next) => {
    state.account = next
    setAccount(next)
  },
  setWorkspace: (next) => {
    state.workspace = next
    setWorkspaceId(next)
  },
  setBootstrap: (mode) => {
    state.bootstrap = mode
  },
  queueListFailure: (failure) => state.listFailures.push(failure),
}

const workspaceFor = (id: string) =>
  ({
    id,
    canDelete: false,
    name: id,
    scene: 'work',
    accent: null,
    logo: { kind: 'monogram' as const },
    sortOrder: 0,
    version: 1,
    updatedAt: '2026-10-02T00:00:00.000Z',
  }) as unknown as WorkspaceSummary

function Harness() {
  // A new account is a new session: a new client and an empty cache, as signing out and in gives.
  const session = createMemo(() => {
    account()
    return {
      client: createFakeClient(state),
      queryClient: new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
    }
  })
  return (
    <QueryClientProvider client={session().queryClient}>
      <WorkspaceDetailsDialog
        open
        client={session().client}
        onClose={() => undefined}
        workspace={workspaceFor(workspaceId())}
      />
    </QueryClientProvider>
  )
}

render(
  () => (
    <ThemeProvider>
      <Harness />
    </ThemeProvider>
  ),
  root
)
