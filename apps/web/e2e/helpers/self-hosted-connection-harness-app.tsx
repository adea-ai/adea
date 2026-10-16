import '../../src/start/globals.css'
import { ThemeProvider } from '@adea-ai/app-ui/components/theme-provider'
import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import { createMemo, createSignal } from 'solid-js'
import { render } from 'solid-js/web'

import SelfHostedConnectionPane from '../../../../packages/workspace-ui/src/self-hosted-connection-pane'
import {
  createFakeClient,
  createFakeOperations,
  createFakeState,
  key,
  host,
  release,
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
    }
  }
}

const root = document.querySelector('#harness-root')!
const flag = (name: string) => root.hasAttribute(name)
const state = createFakeState(flag('data-empty') ? [] : seedHosts())

const [account, setAccount] = createSignal(state.account)
const [workspace, setWorkspace] = createSignal(state.workspace)
const [chosen, setChosen] = createSignal<string>()

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
}

function Harness() {
  // A new client per account, as the app creates one per session.
  const client = createMemo(() => {
    account()
    return createFakeClient(state)
  })
  const operations = createFakeOperations(state, () => undefined)
  const noOperations = flag('data-no-operations')
  const requiredCapabilities = root.getAttribute('data-required-capabilities')?.split(',')
  return (
    <AgentHqQueryProvider>
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
    </AgentHqQueryProvider>
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
