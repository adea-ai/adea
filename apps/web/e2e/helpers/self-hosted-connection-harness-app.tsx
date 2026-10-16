import '../../src/start/globals.css'
import { ThemeProvider } from '@adea-ai/app-ui/components/theme-provider'
import { createWorkspaceEventSubscription } from '@adea-ai/data/events'
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { createMemo, createSignal, onCleanup } from 'solid-js'
import { render } from 'solid-js/web'

import SelfHostedConnectionPane from '../../../../packages/workspace-ui/src/self-hosted-connection-pane'
import {
  createFakeClient,
  createFakeOperations,
  createFakeState,
  key,
  host,
  release,
  releaseList,
  seedHosts,
  type FakeFailure,
  type FakeHost,
  type FakeState,
} from './self-hosted-connection-fixture'

/**
 * Mounts the real self-hosted pane against an in-page fake of the runtime-node routes. The page
 * exposes `window.selfHostedHarness` so a spec can queue failures, move time-sensitive state, change
 * the signed-in account or workspace, and read what left the page. Nothing here is a real
 * endpoint or credential.
 */
declare global {
  interface Window {
    selfHostedHarness: {
      state: FakeState
      heartbeat: (hostId: string) => void
      register: (partial: Partial<FakeHost> & Pick<FakeHost, 'id' | 'displayName'>) => void
      revokeExternally: (hostId: string) => void
      setAccount: (account: string) => void
      setWorkspace: (workspace: string) => void
      queueListFailure: (failure: FakeFailure) => void
      release: () => void
      releaseList: () => void
      /** Delivers a real audience-change frame through the workspace event subscription. */
      audienceChanged: () => void
    }
  }
}

const root = document.querySelector('#harness-root')!
const flag = (name: string) => root.hasAttribute(name)
const state = createFakeState(flag('data-empty') ? [] : seedHosts())

const [account, setAccount] = createSignal(state.account)
const [workspace, setWorkspace] = createSignal(state.workspace)
const [chosen, setChosen] = createSignal<string>()

// The app's own provider settings, with the real event subscription feeding it a frame on demand,
// so an audience reset goes through the production erase-before-refetch path.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
})
let eventController: ReadableStreamDefaultController<Uint8Array> | undefined
let eventSequence = 0
const sendAudienceChanged = () => {
  eventSequence += 1
  eventController?.enqueue(
    new TextEncoder().encode(
      `id: signed.cursor${eventSequence}\nevent: workspace.audience_changed\ndata: ${JSON.stringify({ workspaceSequence: eventSequence })}\n\n`
    )
  )
}

window.selfHostedHarness = {
  state,
  heartbeat: (hostId) => {
    const item = (state.hosts[key(state)] ?? []).find((candidate) => candidate.id === hostId)
    if (item) item.lastProofAt = Date.now()
  },
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
    setWorkspace(next)
  },
  queueListFailure: (failure) => state.listFailures.push(failure),
  release,
  releaseList,
  audienceChanged: () => sendAudienceChanged(),
}

function Harness() {
  // A new client per account, as the app creates one per session.
  const client = createMemo(() => {
    account()
    return createFakeClient(state)
  })
  const subscription = createWorkspaceEventSubscription({
    workspaceId: 'ws-1',
    url: 'https://harness.invalid/events',
    queryClient,
    schedule: () => () => {},
    fetchImpl: (async (_input, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            eventController = controller
            init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
          },
        })
      )) as typeof fetch,
  })
  onCleanup(() => subscription.stop())
  const operations = createFakeOperations(state, () => undefined)
  const noOperations = flag('data-no-operations')
  const requiredCapabilities = root.getAttribute('data-required-capabilities')?.split(',')
  return (
    <QueryClientProvider client={queryClient}>
      <div class="mx-auto max-w-3xl p-4">
        <SelfHostedConnectionPane
          client={client()}
          accountId={account()}
          workspaceId={workspace()}
          operations={noOperations ? {} : operations}
          chosenHostId={chosen()}
          onChooseHost={flag('data-no-choose') ? undefined : setChosen}
          requiredCapabilities={requiredCapabilities}
        />
      </div>
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
