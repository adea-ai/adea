import '../../src/start/globals.css'
import { ThemeProvider } from '@adea-ai/app-ui/components/theme-provider'
import { workspaceQueryOptions } from '@adea-ai/data'
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { WorkspaceSettingsDialog } from '@adea-ai/workspace-ui/workspace-settings'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import type { WorkspaceSummary } from '@adea-ai/types'

import {
  createFakeClient,
  createFakeState,
  host,
  key,
  releaseBootstrap,
  releaseList,
  seedHosts,
  type FakeFailure,
  type FakeHost,
  type FakeState,
} from './self-hosted-connection-fixture'

/**
 * Mounts the real Workspace Details dialog, on its Connections section, over an in-page fake of the
 * runtime-node and bootstrap routes. The dialog gets its account the way the shell hands it one: an
 * accessor over the session principal. One QueryClient lives for the whole page, as the app-level
 * provider does, so nothing is cleared between accounts. `window.selfHostedDetailsHarness` changes
 * the account (a new client, no cache reset), the workspace, or queues failures. Nothing here is a
 * real endpoint or credential.
 */
declare global {
  interface Window {
    selfHostedDetailsHarness: {
      state: FakeState
      register: (partial: Partial<FakeHost> & Pick<FakeHost, 'id' | 'displayName'>) => void
      revokeExternally: (hostId: string) => void
      /** Signs in as an account with a new client; null is a guest (no account). */
      setAccount: (account: string | null) => void
      setWorkspace: (workspace: string) => void
      queueListFailure: (failure: FakeFailure) => void
      releaseList: () => void
      /** Starts the shared bootstrap read the shell makes, for the current client. */
      startBootstrap: () => void
      releaseBootstrap: () => void
      /** The principal the shared bootstrap cache holds, if any. */
      cachedPrincipal: () => string | undefined
    }
  }
}

const root = document.querySelector('#harness-root')!
const state = createFakeState(seedHosts())
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})
const bootstrapKey = workspaceQueryOptions.bootstrap(createFakeClient(state)).queryKey

const guest = root.hasAttribute('data-guest')
const [principal, setPrincipal] = createSignal<string | null>(guest ? null : state.account)
const [client, setClient] = createSignal(createFakeClient(state))
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
    if (next) state.account = next
    setClient(createFakeClient(state))
    setPrincipal(next)
  },
  setWorkspace: (next) => {
    state.workspace = next
    setWorkspaceId(next)
  },
  queueListFailure: (failure) => state.listFailures.push(failure),
  releaseList,
  startBootstrap: () => {
    void queryClient.fetchQuery(workspaceQueryOptions.bootstrap(client()))
  },
  releaseBootstrap,
  cachedPrincipal: () =>
    (queryClient.getQueryData(bootstrapKey) as { principal?: { userId?: string } } | undefined)
      ?.principal?.userId,
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

render(
  () => (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <WorkspaceSettingsDialog
          accountAuthenticated={principal() !== null}
          accountLabel="Account"
          accountPrincipalId={principal}
          agents={[]}
          busy={false}
          open
          client={client()}
          onClose={() => undefined}
          onOpenAgents={() => undefined}
          onSignIn={() => undefined}
          onSignOut={() => undefined}
          workspace={workspaceFor(workspaceId())}
        />
      </QueryClientProvider>
    </ThemeProvider>
  ),
  root
)
