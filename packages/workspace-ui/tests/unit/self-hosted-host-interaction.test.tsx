// The mounted self-hosted host view, exercised as a user would (#188).
//
// These are interaction tests, not source checks: the production mount is rendered into a real DOM,
// the controls are clicked, and what the view does is observed. The DOM has to exist before the
// components are loaded - Solid's browser build decides what it is when it is imported, and the
// mount reaches for `document` as soon as it renders - so the DOM is registered first and the
// components are imported after it.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import type {
  AgentHqApiClient,
  ApiRuntimeNode,
  ApiRuntimeNodeConnectionsResponse,
} from '@adea-ai/api-client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { QueryClient, QueryClientProvider } = await import('@tanstack/solid-query')
const { render } = await import('solid-js/web')
const { default: SelfHostedConnectionsSection } =
  await import('../../src/self-hosted-connections-section')

const PREFERENCE_KEY = 'adea:self-hosted-host:v1'
const QUARANTINE_KEY = 'adea:self-hosted-host:quarantine:v1'
const ACCOUNT_ID = 'account-1'
const WORKSPACE_ID = 'workspace-1'

type RenameCall = Readonly<{ workspaceId: string; runtimeNodeId: string; displayName: string }>

function hostFixture(overrides: Partial<ApiRuntimeNode> = {}): ApiRuntimeNode {
  return {
    id: 'host-1',
    controlPlaneRuntimeNodeRefId: 'rnr_host_1',
    kind: 'remote_host',
    displayName: 'Home server',
    health: 'healthy',
    pairingState: 'paired',
    lastProofAt: '2026-10-07T06:00:00.000Z',
    deviceOnline: { state: 'not_applicable' },
    hostReachability: {
      state: 'unknown',
      dependency: 'control_plane.runtime_connection_discovery.host_reachability',
    },
    platform: 'Linux 6.1',
    softwareVersion: '0.20.0',
    lastSeenAt: '2026-10-07T06:00:00.000Z',
    ...overrides,
  }
}

function connectionsResponse(node: ApiRuntimeNode): ApiRuntimeNodeConnectionsResponse {
  return {
    node: {
      id: node.id,
      controlPlaneRuntimeNodeRefId: node.controlPlaneRuntimeNodeRefId,
      kind: node.kind,
      displayName: node.displayName,
      health: node.health,
      pairingState: node.pairingState,
      lastProofAt: node.lastProofAt,
      deviceOnline: node.deviceOnline,
      hostReachability: node.hostReachability,
    },
    discovery: { state: 'available' },
    controlPlaneReadiness: {
      state: 'unknown',
      dependency: 'control_plane.runtime_connection_discovery.readiness',
    },
    connections: [],
    observedAt: '2026-10-07T06:00:00.000Z',
  }
}

/** Waits for a condition the view reaches on its own, and fails if it never does. */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`the view never showed ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes(text)
  )
}

const mounted: MountedHostView[] = []

/** A mounted view and everything it owns, so the teardown can let go of all of it. */
type MountedHostView = Readonly<{
  container: HTMLElement
  /** The Solid render's disposer. */
  dispose: () => void
  /** The query client this view created. */
  queryClient: InstanceType<typeof QueryClient>
}>

function mount(options: { readonly host: ApiRuntimeNode; readonly remembered?: boolean }) {
  const renames: RenameCall[] = []
  const lists: string[] = []
  const listRuntimeNodes: AgentHqApiClient['listRuntimeNodes'] = async (workspaceId) => {
    lists.push(workspaceId)
    return { nodes: [options.host] }
  }
  const listRuntimeNodeConnections: AgentHqApiClient['listRuntimeNodeConnections'] = async () =>
    connectionsResponse(options.host)
  const renameRuntimeNode: AgentHqApiClient['renameRuntimeNode'] = async (
    workspaceId,
    runtimeNodeId,
    displayName
  ) => {
    renames.push({ workspaceId, runtimeNodeId, displayName })
  }
  // The mount only uses these three calls; the rest of the client is not exercised here.
  const client = {
    listRuntimeNodes,
    listRuntimeNodeConnections,
    renameRuntimeNode,
  } as unknown as AgentHqApiClient
  const container = document.createElement('div')
  document.body.appendChild(container)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={queryClient}>
        <SelfHostedConnectionsSection
          accountId={() => ACCOUNT_ID}
          client={client}
          workspaceId={WORKSPACE_ID}
        />
      </QueryClientProvider>
    ),
    container
  )
  mounted.push({ container, dispose, queryClient })
  return { container, renames, lists }
}

/** Opens the host's detail, the way the list's own button does. */
async function inspect(container: HTMLElement): Promise<void> {
  await waitFor(() => container.querySelector('[data-testid="host-row"]') !== null, 'the host list')
  const inspectButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Inspect"]')
  expect(inspectButton).not.toBeNull()
  inspectButton!.click()
  await waitFor(
    () => (container.textContent ?? '').includes('Manage this host'),
    "the host's own controls"
  )
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    // The render is disposed first: the pane's interval and its query observers belong to it, and
    // they have to stop while the DOM they observe is still there.
    view.dispose()
    // The query client's own state is cleared next, so no observer outlives the view it watches.
    view.queryClient.clear()
    view.queryClient.unmount()
    // Only then does the container go.
    view.container.remove()
  }
  window.localStorage.clear()
})

afterAll(() => {
  GlobalRegistrator.unregister()
})

describe('the mounted host rename', () => {
  test('a healthy host can be renamed through the mounted control', async () => {
    const { container, renames, lists } = mount({ host: hostFixture() })
    await inspect(container)

    const rename = buttonByText(container, 'Rename')
    expect(rename).toBeDefined()
    rename!.click()

    await waitFor(
      () => container.querySelector('input[aria-label="Host name"]') !== null,
      'the rename form'
    )
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Host name"]')!
    input.value = 'Workshop box'
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    const form = container.querySelector<HTMLFormElement>('form[aria-label="Rename host"]')!
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))

    await waitFor(() => renames.length > 0, 'the rename call')
    expect(renames).toEqual([
      { workspaceId: WORKSPACE_ID, runtimeNodeId: 'host-1', displayName: 'Workshop box' },
    ])
    // The list is read again, so what is on screen is what the server holds.
    await waitFor(() => lists.length > 1, 'the host list to be read again')
  })

  test('a revoked host is not offered a rename', async () => {
    const { container, renames } = mount({
      host: hostFixture({ pairingState: 'revoked' }),
    })
    await inspect(container)

    expect(buttonByText(container, 'Rename')).toBeUndefined()
    expect(container.querySelector('[data-testid="rename-revoked"]')).not.toBeNull()
    expect(container.textContent).toContain('A revoked host cannot be renamed.')
    // Nothing was renamed, and nothing could be: the control is not there to press.
    expect(renames).toEqual([])
  })
})

describe('the mounted host note', () => {
  test('a malformed record is quarantined on read, and the view shows no remembered host', async () => {
    window.localStorage.setItem(PREFERENCE_KEY, '{not json')
    const { container } = mount({ host: hostFixture() })

    // The malformed text is preserved, not discarded.
    await waitFor(
      () => window.localStorage.getItem(QUARANTINE_KEY) === '{not json',
      'the malformed record to be quarantined'
    )
    await waitFor(
      () => container.querySelector('[data-testid="host-row"]') !== null,
      'the host list'
    )
    // A broken record reads as no choice.
    expect(container.textContent).not.toContain('Remembered in this browser')
  })

  test('a Forget that could not be stored leaves the note on screen', async () => {
    // A storage that reads but cannot be written to, the way a full quota behaves.
    const items = new Map<string, string>()
    items.set(
      PREFERENCE_KEY,
      JSON.stringify({ version: 1, chosen: { [`${ACCOUNT_ID}:${WORKSPACE_ID}`]: 'host-1' } })
    )
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: () => {
          throw new Error('storage is full')
        },
        removeItem: (key: string) => {
          items.delete(key)
        },
      },
    })
    try {
      const { container } = mount({ host: hostFixture() })
      await waitFor(
        () => (container.textContent ?? '').includes('Remembered in this browser'),
        'the remembered host'
      )
      await inspect(container)

      const forget = buttonByText(container, 'Forget this host')
      expect(forget).toBeDefined()
      forget!.click()

      // The note was not cleared, so the view still shows the host as remembered and still offers
      // the Forget: it never shows a write that did not happen as one that did.
      expect(container.textContent).toContain('Remembered in this browser')
      expect(buttonByText(container, 'Forget this host')).toBeDefined()
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original)
      else delete (window as unknown as { localStorage?: Storage }).localStorage
    }
  })

  test('a remembered host is remembered again after a remount', async () => {
    window.localStorage.setItem(
      PREFERENCE_KEY,
      JSON.stringify({ version: 1, chosen: { [`${ACCOUNT_ID}:${WORKSPACE_ID}`]: 'host-1' } })
    )
    const { container } = mount({ host: hostFixture() })
    await waitFor(
      () => (container.textContent ?? '').includes('Remembered in this browser'),
      'the remembered host'
    )

    // A remount reads the note back: it was persisted, and not only shown.
    const remounted = mount({ host: hostFixture() })
    await waitFor(
      () => (remounted.container.textContent ?? '').includes('Remembered in this browser'),
      'the remembered host after a remount'
    )
  })
})

describe('the mounted host list', () => {
  test('a remembered host is badged as remembered, not as chosen for work', async () => {
    window.localStorage.setItem(
      PREFERENCE_KEY,
      JSON.stringify({ version: 1, chosen: { [`${ACCOUNT_ID}:${WORKSPACE_ID}`]: 'host-1' } })
    )
    const { container } = mount({ host: hostFixture(), remembered: true })
    await waitFor(
      () => container.querySelector('[data-testid="host-row"]') !== null,
      'the host list'
    )
    const row = container.querySelector('[data-testid="host-row"]')!
    expect(row.textContent).toContain('Remembered in this browser')
    // The old badge claimed the choice routed work, and no submission path reads it.
    expect(container.textContent).not.toContain('Chosen for new work')
  })
})
