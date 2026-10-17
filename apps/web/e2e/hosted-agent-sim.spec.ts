// Hosted Agent Sim host embed: the component mounted in a real browser over an in-page stand-in
// for the launch backend and the sim frame. Covers what the controller's unit tests cannot: the
// component's own lifecycle (initial offline, online recovery, configuration changes, a
// configuration that arrives late) and the nonce fencing seen through real iframes and real
// `message` events. No database or host inputs: the spec runs its own local Vite server.
import { expect, test, type Page } from '@playwright/test'
import { type AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import solid from 'vite-plugin-solid'

const fixtureRoot = fileURLToPath(
  new URL('../../../packages/workspace-ui/tests/fixtures/hosted-agent-sim/', import.meta.url)
)
const uiRoot = fileURLToPath(new URL('../../../packages/ui/', import.meta.url))
const uiSourceAliases: Plugin = {
  name: 'adea-ui-source-aliases',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer?.startsWith(`${uiRoot}`)) return null
    if (source.startsWith('#components/')) {
      return resolve(uiRoot, 'src/components', source.slice('#components/'.length))
    }
    if (source.startsWith('#lib/')) {
      return resolve(uiRoot, 'src/lib', source.slice('#lib/'.length))
    }
    return null
  },
}

let fixtureServer: ViteDevServer | undefined
let fixtureUrl = ''

test.beforeAll(async () => {
  fixtureServer = await createServer({
    configFile: false,
    clearScreen: false,
    logLevel: 'error',
    root: fixtureRoot,
    plugins: [uiSourceAliases, solid()],
    resolve: { dedupe: ['solid-js'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, fs: { strict: false } },
  })
  await fixtureServer.listen()
  const address = fixtureServer.httpServer?.address()
  if (!address || typeof address === 'string') {
    throw new Error('Hosted Agent Sim fixture server did not bind an HTTP port')
  }
  fixtureUrl = `http://127.0.0.1:${(address as AddressInfo).port}`
})

test.afterAll(async () => {
  await fixtureServer?.close()
})

type Grant = { workspaceId: string; surface: string; bridgeId: string; platform: string }
type FrameMessage =
  | { type: 'frame.ready'; payload: Record<string, never> }
  | { type: 'frame.state'; payload: { state: 'running' } }
  | { type: 'frame.navigate'; payload: { requestId: string; target: string } }
  | { type: 'frame.character.save'; payload: { requestId: string; character: string } }

async function open(page: Page, query = '') {
  await page.goto(`${fixtureUrl}/${query}`)
  await page.waitForFunction(() => 'agentSimHarness' in window)
}

const grants = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { agentSimHarness: { grants: Grant[] } }).agentSimHarness.grants.slice()
  )

const received = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { agentSimHarness: { received(): unknown[] } }).agentSimHarness.received()
  )

const iframeSource = (page: Page) => page.locator('iframe').getAttribute('src')

function deliver(page: Page, message: FrameMessage, bridgeId: string, version?: number) {
  return page.evaluate(
    ([next, id, v]) =>
      (
        window as unknown as {
          agentSimHarness: { deliver(message: unknown, bridgeId: string, version?: number): void }
        }
      ).agentSimHarness.deliver(next, id, v),
    [message, bridgeId, version] as const
  )
}

const call = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ([name, values]) =>
      (window as unknown as { agentSimHarness: Record<string, (...a: unknown[]) => void> })
        .agentSimHarness[name as string]!(...(values as unknown[])),
    [method, args] as const
  )

const READY: FrameMessage = { type: 'frame.ready', payload: {} }

test.describe('initial offline mount', () => {
  test('shows the offline state with a retry, asks nothing, and recovers when back online', async ({
    page,
  }) => {
    await open(page, '?online=0')

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Agent Sim is offline')
    await expect(alert).toContainText('Chat and Dev are not affected')
    await expect(page.locator('iframe')).toHaveCount(0)
    expect(await grants(page)).toHaveLength(0)

    // Retrying while still offline stays offline and still asks nothing.
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(alert).toContainText('Agent Sim is offline')
    expect(await grants(page)).toHaveLength(0)

    // Coming back online starts the launch without any click.
    await call(page, 'setOnline', true)
    await expect(page.locator('iframe')).toHaveCount(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(await grants(page)).toHaveLength(1)
  })

  test('the retry works once connectivity is back even if the online event was missed', async ({
    page,
  }) => {
    await open(page, '?online=0')
    await expect(page.getByRole('alert')).toContainText('Agent Sim is offline')
    await page.evaluate(() => {
      // Connectivity returns without an `online` event reaching the page.
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    })
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.locator('iframe')).toHaveCount(1)
    expect(await grants(page)).toHaveLength(1)
  })

  test('going offline mid-launch and back online relaunches with a new channel nonce', async ({
    page,
  }) => {
    await open(page)
    await expect(page.locator('iframe')).toHaveCount(1)
    const [first] = await grants(page)
    await call(page, 'setOnline', false)
    await expect(page.getByRole('alert')).toContainText('Agent Sim is offline')
    await expect(page.locator('iframe')).toHaveCount(0)
    await call(page, 'setOnline', true)
    await expect(page.locator('iframe')).toHaveCount(1)
    const all = await grants(page)
    expect(all).toHaveLength(2)
    expect(all[1]!.bridgeId).not.toBe(first!.bridgeId)
  })
})

test.describe('configuration changes', () => {
  test('a new workspace disposes the old launch and binds the new grant, nonce and frame together', async ({
    page,
  }) => {
    await open(page)
    await expect(page.locator('iframe')).toHaveCount(1)
    const [first] = await grants(page)
    expect(first).toMatchObject({ workspaceId: 'ws_a', surface: 'hq' })
    expect(await iframeSource(page)).toContain(encodeURIComponent(first!.bridgeId))

    await deliver(page, READY, first!.bridgeId)
    await expect.poll(async () => (await received(page)).length).toBe(1)
    expect((await received(page))[0]).toMatchObject({ type: 'host.launch' })

    await call(page, 'setWorkspaceId', 'ws_b')
    await expect.poll(async () => (await grants(page)).length).toBe(2)
    const second = (await grants(page))[1]!
    expect(second).toMatchObject({ workspaceId: 'ws_b', surface: 'hq' })
    expect(second.bridgeId).not.toBe(first!.bridgeId)

    // One frame, navigated for the new attempt, not the old element re-pointed.
    await expect(page.locator('iframe')).toHaveCount(1)
    await expect(page.locator('iframe')).toHaveAttribute(
      'src',
      new RegExp(encodeURIComponent(second.bridgeId))
    )
    await expect.poll(async () => (await received(page)).length).toBe(0)

    // The previous attempt's nonce cannot launch the new frame...
    await deliver(page, READY, first!.bridgeId)
    await page.waitForTimeout(150)
    expect(await received(page)).toHaveLength(0)
    // ...and the new attempt's nonce does, with its own grant code.
    await deliver(page, READY, second.bridgeId)
    await expect.poll(async () => (await received(page)).length).toBe(1)
    expect((await received(page))[0]).toMatchObject({
      type: 'host.launch',
      payload: { code: expect.stringMatching(/^02/) },
    })
  })

  test('a signal read by a stable frameUrl callback cannot navigate a running frame', async ({
    page,
  }) => {
    await open(page)
    await expect(page.locator('iframe')).toHaveCount(1)
    const [grant] = await grants(page)
    const source = await iframeSource(page)
    expect(source).toContain('view=a')

    await deliver(page, READY, grant!.bridgeId)
    await expect.poll(async () => (await received(page)).length).toBe(1)
    await deliver(page, { type: 'frame.state', payload: { state: 'running' } }, grant!.bridgeId)
    await expect(page.locator('iframe')).toHaveAttribute('data-agent-sim-active', 'true')

    // An unrelated signal the caller's callback happens to read changes while the frame runs.
    await call(page, 'setView', 'b')
    await page.waitForTimeout(250)

    // The frame was not navigated: same address, same window (it still holds what the host posted),
    // still running, and no second launch.
    expect(await iframeSource(page)).toBe(source)
    expect(await received(page)).toHaveLength(1)
    await expect(page.locator('iframe')).toHaveAttribute('data-agent-sim-active', 'true')
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(await grants(page)).toHaveLength(1)
  })

  test('a new surface launches again for that surface', async ({ page }) => {
    await open(page)
    await expect(page.locator('iframe')).toHaveCount(1)
    await call(page, 'setSurface', 'room-designer')
    await expect.poll(async () => (await grants(page)).length).toBe(2)
    expect((await grants(page))[1]).toMatchObject({ surface: 'room-designer' })
    await expect(page.locator('iframe')).toHaveCount(1)
  })

  test('a configuration that arrives late starts the launch', async ({ page }) => {
    await open(page, '?origin=none')
    await expect(page.getByRole('alert')).toContainText('Agent Sim is not set up here')
    await expect(page.locator('iframe')).toHaveCount(0)
    expect(await grants(page)).toHaveLength(0)

    const origin = await page.evaluate(
      () =>
        (window as unknown as { agentSimHarness: { frameOrigin: string } }).agentSimHarness
          .frameOrigin
    )
    await call(page, 'setFrameOrigin', origin)
    await expect(page.locator('iframe')).toHaveCount(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(await grants(page)).toHaveLength(1)
  })

  test('removing the configuration tears the launch down', async ({ page }) => {
    await open(page)
    await expect(page.locator('iframe')).toHaveCount(1)
    await call(page, 'setFrameOrigin', null)
    await expect(page.getByRole('alert')).toContainText('Agent Sim is not set up here')
    await expect(page.locator('iframe')).toHaveCount(0)
    expect(await grants(page)).toHaveLength(1)
  })
})

test.describe('protocol version and channel nonce', () => {
  test('an unsupported version under the wrong nonce does not fail the current attempt', async ({
    page,
  }) => {
    await open(page)
    await expect(page.locator('iframe')).toHaveCount(1)
    const [grant] = await grants(page)

    await deliver(page, READY, 'wrong-nonce-wrong-nonce', 2)
    await page.waitForTimeout(150)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('iframe')).toHaveCount(1)

    // The real frame still launches.
    await deliver(page, READY, grant!.bridgeId)
    await expect.poll(async () => (await received(page)).length).toBe(1)
  })

  test('an unsupported version under the current nonce asks for an update', async ({ page }) => {
    await open(page)
    await expect(page.locator('iframe')).toHaveCount(1)
    const [grant] = await grants(page)
    await deliver(page, READY, grant!.bridgeId, 2)
    await expect(page.getByRole('alert')).toContainText('Agent Sim needs an update')
    await expect(page.locator('iframe')).toHaveCount(0)
  })
})

const SERIALIZED =
  'character:v1:body-body-01|ears-ears-01|face-female-emotion-usual-01|hair-hairstyle-female-01|-|top-outfit-01|bottom-pants-01|shoes-shoe-sneakers-01|-|-|-|-|-'

const harnessList = (page: Page, name: 'navigations' | 'saves') =>
  page.evaluate(
    (key) =>
      (window as unknown as { agentSimHarness: Record<string, unknown[]> }).agentSimHarness[
        key
      ]!.slice(),
    name
  )

async function running(page: Page) {
  await open(page)
  await expect(page.locator('iframe')).toHaveCount(1)
  const [grant] = await grants(page)
  await deliver(page, READY, grant!.bridgeId)
  await expect.poll(async () => (await received(page)).length).toBe(1)
  await deliver(page, { type: 'frame.state', payload: { state: 'running' } }, grant!.bridgeId)
  await expect(page.locator('iframe')).toHaveAttribute('data-agent-sim-active', 'true')
  return grant!
}

const receivedResults = async (page: Page) =>
  (await received(page)).filter(
    (message) => (message as { type?: string }).type === 'host.character.save.result'
  )

test.describe('frame navigation', () => {
  test('HQ asking for a designer disposes the frame and launches that surface with a fresh grant', async ({
    page,
  }) => {
    const first = await running(page)
    await deliver(
      page,
      { type: 'frame.navigate', payload: { requestId: 'nav1', target: 'room-designer' } },
      first.bridgeId
    )

    await expect.poll(async () => (await grants(page)).length).toBe(2)
    const second = (await grants(page))[1]!
    expect(second).toMatchObject({ workspaceId: 'ws_a', surface: 'room-designer' })
    expect(second.bridgeId).not.toBe(first.bridgeId)
    expect(await harnessList(page, 'navigations')).toEqual([
      { target: 'room-designer', requestId: 'nav1' },
    ])

    // One new frame bound to the new nonce; the old nonce can neither launch it nor navigate again.
    await expect(page.locator('iframe')).toHaveAttribute(
      'src',
      new RegExp(encodeURIComponent(second.bridgeId))
    )
    await expect.poll(async () => (await received(page)).length).toBe(0)
    await deliver(page, READY, first.bridgeId)
    await deliver(
      page,
      { type: 'frame.navigate', payload: { requestId: 'nav2', target: 'character-designer' } },
      first.bridgeId
    )
    await page.waitForTimeout(150)
    expect(await received(page)).toHaveLength(0)
    expect(await grants(page)).toHaveLength(2)
    expect(await harnessList(page, 'navigations')).toHaveLength(1)

    // The new surface's grant carries its own single-use code.
    await deliver(page, READY, second.bridgeId)
    await expect.poll(async () => (await received(page)).length).toBe(1)
    expect((await received(page))[0]).toMatchObject({
      type: 'host.launch',
      payload: { surface: 'room-designer', code: expect.stringMatching(/^02/) },
    })
  })

  test('a navigation to HQ or an address is refused and the frame keeps running', async ({
    page,
  }) => {
    const grant = await running(page)
    for (const target of ['hq', 'https://evil.example/'])
      await deliver(
        page,
        { type: 'frame.navigate', payload: { requestId: 'n', target } },
        grant.bridgeId
      )
    await page.waitForTimeout(150)
    expect(await harnessList(page, 'navigations')).toHaveLength(0)
    expect(await grants(page)).toHaveLength(1)
    await expect(page.locator('iframe')).toHaveAttribute('data-agent-sim-active', 'true')
  })
})

test.describe('acknowledged character save', () => {
  test('the host answers the same request only after the app commits the serialized value', async ({
    page,
  }) => {
    const grant = await running(page)
    await deliver(
      page,
      { type: 'frame.character.save', payload: { requestId: 'save1', character: SERIALIZED } },
      grant.bridgeId
    )
    await expect
      .poll(async () => receivedResults(page))
      .toEqual([
        expect.objectContaining({
          payload: { requestId: 'save1', saved: true },
        }),
      ])
    expect(await harnessList(page, 'saves')).toEqual([
      { character: SERIALIZED, requestId: 'save1' },
    ])
  })

  test('a refused save is answered as refused, never as saved', async ({ page }) => {
    const grant = await running(page)
    await call(page, 'setSaveMode', 'refuse')
    await deliver(
      page,
      { type: 'frame.character.save', payload: { requestId: 'save1', character: SERIALIZED } },
      grant.bridgeId
    )
    await expect
      .poll(async () => receivedResults(page))
      .toEqual([
        expect.objectContaining({
          payload: { requestId: 'save1', saved: false, reason: 'refused' },
        }),
      ])
  })

  test('malformed values and stale nonces never reach the app', async ({ page }) => {
    const grant = await running(page)
    for (const character of [`${SERIALIZED}|-`, 'character:v1:body-body-01'])
      await deliver(
        page,
        { type: 'frame.character.save', payload: { requestId: 'bad', character } },
        grant.bridgeId
      )
    await deliver(
      page,
      { type: 'frame.character.save', payload: { requestId: 'old', character: SERIALIZED } },
      'wrong-nonce-wrong-nonce'
    )
    await page.waitForTimeout(150)
    expect(await harnessList(page, 'saves')).toHaveLength(0)
    expect(await receivedResults(page)).toHaveLength(0)
  })

  test('a save left pending when the surface changes is never answered to the next frame', async ({
    page,
  }) => {
    const grant = await running(page)
    await call(page, 'setSaveMode', 'hang')
    await deliver(
      page,
      { type: 'frame.character.save', payload: { requestId: 'save1', character: SERIALIZED } },
      grant.bridgeId
    )
    await expect.poll(async () => (await harnessList(page, 'saves')).length).toBe(1)
    await call(page, 'setSurface', 'character-designer')
    await expect.poll(async () => (await grants(page)).length).toBe(2)
    await page.waitForTimeout(150)
    expect(await receivedResults(page)).toHaveLength(0)
  })
})
