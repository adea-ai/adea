import { describe, expect, test } from 'bun:test'

import {
  createBunWebViewLaneEngine,
  type BrowserWebView,
  type BrowserWebViewFactory,
} from '../shell/src/dev-runtime/browser/engine'
import {
  createBrowserLaneRegistry,
  type BrowserLaneRecord,
} from '../shell/src/dev-runtime/browser/lane-registry'
import { encodeCbor } from '../../../packages/types/src/dev-runtime'
import type { DevStreamFrame } from '../../../packages/types/src/dev-runtime'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

type Listener = (event: { data: unknown }) => void

class FakeWebView implements BrowserWebView {
  url = 'about:blank'
  title = ''
  private readonly listeners = new Map<string, Listener[]>()
  readonly cdpCalls: { method: string; params?: Record<string, unknown> }[] = []
  readonly options: Parameters<BrowserWebViewFactory>[0]
  private nextUrl: string | undefined

  constructor(options: Parameters<BrowserWebViewFactory>[0]) {
    this.options = options
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  private dispatch(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }

  async navigate(url: string): Promise<void> {
    if (url === 'about:blank') {
      this.url = url
      return
    }
    this.nextUrl = url
    this.dispatch('Fetch.requestPaused', {
      requestId: 'request-1',
      resourceType: 'Document',
      request: { url },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    this.url = this.nextUrl ?? url
    this.title = 'Example'
    this.dispatch('Page.loadEventFired', {})
  }

  async evaluate<T = unknown>(_script: string): Promise<T> {
    return { text: 'Example' } as T
  }

  async screenshot(_options: {
    encoding: 'buffer'
    format: 'png' | 'jpeg' | 'webp'
    quality?: number
  }): Promise<Buffer> {
    return Buffer.from([137, 80, 78, 71])
  }

  async cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.cdpCalls.push({ method, ...(params ? { params } : {}) })
    if (method === 'Fetch.continueRequest') this.nextUrl = String(params?.url ?? this.nextUrl)
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } } as T
    if (method === 'DOM.querySelector') return { nodeId: 2 } as T
    if (method === 'DOM.describeNode') return { node: { attributes: ['role', 'button'] } } as T
    if (method === 'DOM.getBoxModel')
      return { model: { border: [1, 2, 21, 2, 21, 12, 1, 12] } } as T
    if (method === 'DOM.requestNode') return { nodeId: 3 } as T
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 } as T
    if (method === 'Page.getFrameTree')
      return {
        frameTree: {
          frame: { id: 'root-frame', url: 'https://example.test/' },
          childFrames: [{ frame: { id: 'child-frame', url: 'https://embed.test/' } }],
        },
      } as T
    if (method === 'Runtime.evaluate') {
      if (params?.contextId === 42) return { result: { objectId: 'child-node' } } as T
      return { result: { value: { text: 'Example' } } } as T
    }
    if (method === 'Runtime.callFunctionOn')
      return {
        result: {
          value: {
            role: 'button',
            name: 'Embedded action',
            bounds: { x: 3, y: 4, width: 50, height: 20 },
          },
        },
      } as T
    return {} as T
  }

  async resize(_width: number, _height: number): Promise<void> {}
  async click(_x: number, _y: number): Promise<void> {}
  async type(_text: string): Promise<void> {}
  async press(_key: string): Promise<void> {}
  async scroll(_dx: number, _dy: number): Promise<void> {}
  close(): void {}

  screencast(bytes = [1, 2, 3]): void {
    this.dispatch('Page.screencastFrame', {
      sessionId: 9,
      data: Buffer.from(bytes).toString('base64'),
      metadata: { isKeyFrame: true },
    })
  }
}

function lane(kind: BrowserLaneRecord['kind'] = 'task_owned'): BrowserLaneRecord {
  const lanes = createBrowserLaneRegistry()
  return lanes.create({ scope, runtimeSessionId: 'session-1', kind })
}

function fakeFactory(created: FakeWebView[]): BrowserWebViewFactory {
  return (options) => {
    const view = new FakeWebView(options)
    created.push(view)
    return view
  }
}

function admission(url: string) {
  return Promise.resolve({
    allowed: true as const,
    normalizedUrl: url,
    pinnedAddresses: [{ address: '93.184.216.34', family: 4 as const }],
  })
}

describe('live Bun WebView/CDP browser engine', () => {
  test('does not pretend the shell CEF context is a Bun CDP target', async () => {
    const engine = createBunWebViewLaneEngine({ webViewFactory: fakeFactory([]) })
    expect(() => engine.targets(lane('human_embedded'))).toThrow(
      'packaged CEF BrowserView/CDP handle is not exposed'
    )
  })

  test('admits the initial document at Fetch.requestPaused and exposes targets, screenshot, and inspection', async () => {
    const views: FakeWebView[] = []
    const engine = createBunWebViewLaneEngine({
      dataDir: '/tmp/adea-browser-engine-test',
      webViewFactory: fakeFactory(views),
    })
    const browserLane = lane()
    const result = await engine.navigate(browserLane, 'https://example.test/', {
      admitHop: admission,
    })
    expect(result).toMatchObject({
      targetId: `browser-target-${browserLane.id}`,
      finalUrl: 'https://example.test/',
    })
    expect(views).toHaveLength(1)
    expect(views[0]?.cdpCalls.map((call) => call.method)).toEqual([
      'Page.enable',
      'Runtime.enable',
      'DOM.enable',
      'Network.enable',
      'Fetch.enable',
      'Fetch.continueRequest',
      'Page.getFrameTree',
    ])
    expect(engine.targets(browserLane)[0]).toMatchObject({
      url: 'https://example.test/',
      title: 'Example',
    })
    expect(engine.targets(browserLane)).toContainEqual({
      id: `browser-frame-${browserLane.id}-child-frame`,
      type: 'frame',
      url: 'https://embed.test/',
      title: '',
    })
    expect((await engine.screenshot(browserLane, { format: 'png' })).bytes).toEqual(
      new Uint8Array([137, 80, 78, 71])
    )
    expect(
      await engine.inspect(browserLane, {
        targetId: `browser-target-${browserLane.id}`,
        selector: '#submit',
      })
    ).toMatchObject({
      nodeId: '2',
      role: 'button',
      bounds: { x: 1, y: 2, width: 20, height: 10 },
    })
  })

  test('consumes iframe targets through a frame execution context for element picking', async () => {
    const views: FakeWebView[] = []
    const engine = createBunWebViewLaneEngine({ webViewFactory: fakeFactory(views) })
    const browserLane = lane()
    await engine.navigate(browserLane, 'https://example.test/', { admitHop: admission })
    const frameTarget = engine.targets(browserLane).find((target) => target.type === 'frame')
    expect(frameTarget).toBeDefined()
    const picked = await engine.inspect(browserLane, {
      targetId: frameTarget?.id ?? '',
      selector: '#embedded-action',
    })
    expect(picked).toEqual({
      nodeId: '3',
      role: 'button',
      name: 'Embedded action',
      bounds: { x: 3, y: 4, width: 50, height: 20 },
    })
    expect(views[0]?.cdpCalls.map((call) => call.method)).toContain('Page.createIsolatedWorld')
    expect(views[0]?.cdpCalls.map((call) => call.method)).toContain('Runtime.callFunctionOn')
  })

  test('refuses simultaneous reuse of one persistent profile and releases the lease on close', async () => {
    const views: FakeWebView[] = []
    const engine = createBunWebViewLaneEngine({
      dataDir: '/tmp/adea-browser-engine-profile-lease-test',
      webViewFactory: fakeFactory(views),
    })
    const first = lane()
    const second = lane()
    await engine.navigate(first, 'https://example.test/', { admitHop: admission })
    await expect(
      engine.navigate(second, 'https://example.test/', { admitHop: admission })
    ).rejects.toMatchObject({ code: 'capability_unavailable' })
    engine.close(first)
    await expect(
      engine.navigate(second, 'https://example.test/', { admitHop: admission })
    ).resolves.toMatchObject({
      finalUrl: 'https://example.test/',
    })
  })

  test('publishes bounded video frames and admits CBOR input/resize through the live view', async () => {
    const views: FakeWebView[] = []
    const engine = createBunWebViewLaneEngine({ webViewFactory: fakeFactory(views) })
    const browserLane = lane()
    await engine.navigate(browserLane, 'https://example.test/', { admitHop: admission })
    const frames: DevStreamFrame[] = []
    const session = {
      grant: {
        maxFrameBytes: 8 * 1024 * 1024,
        resource: { id: browserLane.id, generation: browserLane.generation },
      },
      send: (frame: DevStreamFrame) => frames.push(frame),
      close: () => {},
      onFrame: undefined as ((frame: DevStreamFrame) => void) | undefined,
      onClose: undefined as (() => void) | undefined,
    }
    engine.attachStream(session)
    await new Promise((resolve) => setTimeout(resolve, 0))
    views[0]?.screencast([5, 6, 7])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(frames.find((frame) => frame.type === 'video')).toMatchObject({
      type: 'video',
      sequence: '1',
      keyframe: true,
    })

    const input = encodeCbor({ kind: 'click', x: 4, y: 5 })
    session.onFrame?.({
      type: 'input',
      sequence: '0',
      generation: browserLane.generation,
      bytes: input,
    })
    session.onFrame?.({
      type: 'resize',
      sequence: '1',
      generation: browserLane.generation,
      cols: 900,
      rows: 600,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(views[0]?.cdpCalls.some((call) => call.method === 'Page.startScreencast')).toBe(true)
  })

  test('provisions a lane when the first frames stream attaches before navigation', async () => {
    const views: FakeWebView[] = []
    const lanes = createBrowserLaneRegistry()
    const browserLane = lanes.create({ scope, runtimeSessionId: 'session-1', kind: 'task_owned' })
    const engine = createBunWebViewLaneEngine({
      webViewFactory: fakeFactory(views),
      laneLookup: (laneId) => {
        try {
          return lanes.get(laneId)
        } catch {
          return undefined
        }
      },
    })
    const frames: DevStreamFrame[] = []
    const session = {
      grant: {
        maxFrameBytes: 8 * 1024 * 1024,
        resource: { id: browserLane.id, generation: browserLane.generation },
      },
      send: (frame: DevStreamFrame) => frames.push(frame),
      close: () => {},
      onFrame: undefined as ((frame: DevStreamFrame) => void) | undefined,
      onClose: undefined as (() => void) | undefined,
    }
    engine.attachStream(session)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(views).toHaveLength(1)
    views[0]?.screencast([8, 9, 10])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(frames.find((frame) => frame.type === 'video')).toMatchObject({
      type: 'video',
      sequence: '1',
      keyframe: true,
    })
    engine.close(browserLane)
  })

  test('does not attach a stream after its socket closes during first-view provisioning', async () => {
    const views: FakeWebView[] = []
    let releasePrepare!: () => void
    const prepare = new Promise<void>((resolve) => {
      releasePrepare = resolve
    })
    const lanes = createBrowserLaneRegistry()
    const browserLane = lanes.create({ scope, runtimeSessionId: 'session-1', kind: 'task_owned' })
    const engine = createBunWebViewLaneEngine({
      webViewFactory: (options) => {
        const view = new (class extends FakeWebView {
          override async navigate(url: string): Promise<void> {
            if (url === 'about:blank') await prepare
            await super.navigate(url)
          }
        })(options)
        views.push(view)
        return view
      },
      laneLookup: (laneId) => {
        try {
          return lanes.get(laneId)
        } catch {
          return undefined
        }
      },
    })
    const frames: DevStreamFrame[] = []
    let closeCalls = 0
    const session = {
      grant: {
        maxFrameBytes: 8 * 1024 * 1024,
        resource: { id: browserLane.id, generation: browserLane.generation },
      },
      send: (frame: DevStreamFrame) => frames.push(frame),
      close: () => {
        closeCalls += 1
      },
      onFrame: undefined as ((frame: DevStreamFrame) => void) | undefined,
      onClose: undefined as (() => void) | undefined,
    }
    engine.attachStream(session)
    expect(session.onClose).toBeDefined()
    session.onClose?.()
    releasePrepare()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(views).toHaveLength(1)
    views[0]?.screencast([11, 12, 13])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(frames.find((frame) => frame.type === 'video')).toBeUndefined()
    expect(closeCalls).toBe(0)
    engine.close(browserLane)
  })

  test('refuses a first attach when lane ownership changes during provisioning', async () => {
    let releasePrepare!: () => void
    const prepare = new Promise<void>((resolve) => {
      releasePrepare = resolve
    })
    const lanes = createBrowserLaneRegistry()
    const browserLane = lanes.create({ scope, runtimeSessionId: 'session-1', kind: 'task_owned' })
    const engine = createBunWebViewLaneEngine({
      webViewFactory: (options) =>
        new (class extends FakeWebView {
          override async navigate(url: string): Promise<void> {
            if (url === 'about:blank') await prepare
            await super.navigate(url)
          }
        })(options),
      laneLookup: (laneId) => {
        try {
          return lanes.get(laneId)
        } catch {
          return undefined
        }
      },
    })
    let refused: { code: string; reason?: string } | undefined
    const session = {
      grant: {
        maxFrameBytes: 8 * 1024 * 1024,
        resource: { id: browserLane.id, generation: browserLane.generation },
      },
      send: () => {},
      close: (code: string, reason?: string) => {
        refused = { code, ...(reason ? { reason } : {}) }
      },
      onFrame: undefined as ((frame: DevStreamFrame) => void) | undefined,
      onClose: undefined as (() => void) | undefined,
    }
    engine.attachStream(session)
    const takenOver = lanes.takeover(browserLane.id, browserLane.generation)
    releasePrepare()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(refused).toEqual({
      code: 'stale_generation',
      reason: 'browser lane generation changed',
    })
    engine.close(takenOver)
  })

  test('Escape invokes the generation-fenced release hook', async () => {
    const views: FakeWebView[] = []
    const released: string[] = []
    const engine = createBunWebViewLaneEngine({
      webViewFactory: fakeFactory(views),
      onEscape: (laneId) => released.push(laneId),
    })
    const browserLane = lane()
    await engine.navigate(browserLane, 'https://example.test/', { admitHop: admission })
    const session = {
      grant: {
        maxFrameBytes: 1024,
        resource: { id: browserLane.id, generation: browserLane.generation },
      },
      send: () => {},
      close: () => {},
      onFrame: undefined as ((frame: DevStreamFrame) => void) | undefined,
      onClose: undefined as (() => void) | undefined,
    }
    engine.attachStream(session)
    session.onFrame?.({
      type: 'input',
      sequence: '0',
      generation: browserLane.generation,
      bytes: encodeCbor({ kind: 'key', key: 'Escape' }),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(released).toEqual([browserLane.id])
  })
})
