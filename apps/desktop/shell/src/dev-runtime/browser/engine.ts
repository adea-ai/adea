// Live browser lane engine for Bun 1.4's headless WebView/CDP backend.
//
// The shell itself remains the bundled Electrobun/CEF window. Browser lanes
// get their own WebView process and owner-only profile directory, so a lane
// can never reuse the shell or another lane's profile. Navigation is paused at
// the CDP Fetch request boundary and every document hop goes back through the
// provider admission hook before it is continued. The engine is deliberately
// injected at the WebView seam in tests; production uses Bun.WebView with the
// Chrome backend so CDP and screencast events are available on macOS too.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { DevStreamFrame } from '../../../../../../packages/types/src/dev-runtime'
import { decodeCbor } from '../../../../../../packages/types/src/dev-runtime'
import type { StreamProvider } from '../channel/server'

import { createLaneScreencast, type LaneScreencast } from './screencast'
import type {
  LaneEngine,
  LaneHopAdmission,
  LaneNavigationHooks,
  LaneNavigationOutcome,
} from './providers'
import type { BrowserLaneRecord, LaneViewport } from './lane-registry'

type WebViewEvent = { data: unknown }

/** Narrow testable surface over Bun.WebView. */
export type BrowserWebView = Readonly<{
  url: string
  title: string
  navigate(url: string): Promise<void>
  evaluate<T = unknown>(script: string): Promise<T>
  screenshot(options: {
    encoding: 'buffer'
    format: 'png' | 'jpeg' | 'webp'
    quality?: number
  }): Promise<Buffer>
  cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  addEventListener(type: string, listener: (event: WebViewEvent) => void): void
  resize(width: number, height: number): Promise<void>
  click(x: number, y: number): Promise<void>
  type(text: string): Promise<void>
  press(key: string): Promise<void>
  scroll(dx: number, dy: number): Promise<void>
  close(): void
}>

export type BrowserWebViewFactory = (options: {
  width: number
  height: number
  headless: true
  backend: { type: 'chrome'; url: false; argv?: string[] }
  dataStore: { directory: string }
  console: (type: string, ...args: unknown[]) => void
}) => BrowserWebView

export type BrowserEngineDiagnostic = Readonly<{
  level: 'info' | 'warning' | 'error'
  category: 'console' | 'network' | 'crash' | 'policy'
  message: string
}>

export type BrowserFrameStream = Parameters<StreamProvider>[0]

export type BunWebViewLaneEngineOptions = Readonly<{
  /** Owner-only root for persistent lane profiles. */
  dataDir?: string
  webViewFactory?: BrowserWebViewFactory
  /**
   * Overrides the WebView backend availability probe. The default probe
   * checks for `Bun.WebView` on this host; tests script the engine-less
   * host with `() => false`. Only consulted when no `webViewFactory` is
   * injected.
   */
  webViewBackendProbe?: () => boolean
  /** Resolves a granted lane before its first stream/screenshot/navigation. */
  laneLookup?: (laneId: string) => BrowserLaneRecord | undefined
  laneGeneration?: (laneId: string) => number | undefined
  onDiagnostic?: (laneId: string, diagnostic: BrowserEngineDiagnostic) => void
  onEscape?: (laneId: string) => void
  now?: () => number
}>

type NavigationState = {
  hooks: LaneNavigationHooks
  hops: { url: string; status: number }[]
  refused?: { code: 'ssrf_blocked' | 'navigation_blocked'; reason: string }
}

type Subscriber = {
  session: BrowserFrameStream
  pacer: LaneScreencast
  creditBytes: number
}

type LaneState = {
  lane: BrowserLaneRecord
  view: BrowserWebView
  targetId: string
  rootFrameId?: string
  frames: Map<string, FrameState>
  navigation?: NavigationState
  viewportSequence: number
  frameSequence: bigint
  screencastStarted: boolean
  subscribers: Set<Subscriber>
}

type FrameState = Readonly<{
  id: string
  parentId?: string
  url: string
  title: string
}>

function frameTargetId(laneId: string, frameId: string): string {
  return `browser-frame-${laneId}-${frameId}`
}

function closeSubscribers(
  state: LaneState,
  code: 'normal' | 'stale_generation' | 'incompatible',
  reason: string
): void {
  for (const subscriber of state.subscribers) {
    try {
      subscriber.session.close(code, reason)
    } catch {
      // A socket can close while a frame is being published.
    }
  }
  state.subscribers.clear()
}

function removeSubscriber(state: LaneState, subscriber: Subscriber): void {
  subscriber.pacer.close()
  state.subscribers.delete(subscriber)
}

async function prepareBrowserView(view: BrowserWebView): Promise<void> {
  await view.navigate('about:blank')
  await view.cdp('Page.enable')
  await view.cdp('Runtime.enable')
  await view.cdp('DOM.enable')
  await view.cdp('Network.enable')
  await view.cdp('Fetch.enable', {
    patterns: [{ requestStage: 'Request', resourceType: 'Document' }],
  })
}

const DEFAULT_DATA_DIR = join(process.env.HOME ?? '.', 'Library', 'Application Support', 'Adea')
const MAX_INPUT_BYTES = 4096
const MAX_TEXT_INPUT = 4096

/**
 * The profile root every lane lives under. Exported because a lane's profile is
 * addressed from outside the engine too (the cookie import target writes the
 * profile's own store), and two formulas for one path is how an import ends up
 * confidently writing a store the browser never reads.
 */
export function browserLaneProfileRoot(dataDir?: string): string {
  const root = dataDir ?? process.env.ADEA_DATA_DIR ?? DEFAULT_DATA_DIR
  return join(root, 'dev-runtime', 'browser', 'profiles')
}

export function browserLaneProfileDirectory(
  lane: Pick<BrowserLaneRecord, 'profileDirectory'>,
  dataDir?: string
): string {
  return join(browserLaneProfileRoot(dataDir), lane.profileDirectory)
}

function defaultFactory(options: Parameters<BrowserWebViewFactory>[0]): BrowserWebView {
  return new Bun.WebView(options) as unknown as BrowserWebView
}

/**
 * Whether this host can construct the headless WebView backend at all. An
 * engine-less host (no `Bun.WebView`) is an environmental absence, not a lane
 * fault: live-target operations must refuse typed-`capability_unavailable`
 * instead of letting the bare factory TypeError crash the lane.
 */
function probeBunWebViewBackend(): boolean {
  const backend = (globalThis as { Bun?: { WebView?: unknown } }).Bun?.WebView
  return typeof backend === 'function'
}

function messageFrom(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 4096)
  if (value && typeof value === 'object') {
    const descriptor = value as { description?: unknown; value?: unknown }
    if (typeof descriptor.description === 'string') return descriptor.description.slice(0, 4096)
    if (typeof descriptor.value === 'string') return descriptor.value.slice(0, 4096)
  }
  try {
    return JSON.stringify(value).slice(0, 4096)
  } catch {
    return 'browser diagnostic could not be serialized'
  }
}

function boundsFromQuad(
  quad: unknown
): { x: number; y: number; width: number; height: number } | undefined {
  if (!Array.isArray(quad) || quad.length < 8) return undefined
  const points = quad.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  )
  if (points.length < 8) return undefined
  const xs = points.filter((_value, index) => index % 2 === 0)
  const ys = points.filter((_value, index) => index % 2 === 1)
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function inputObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) return undefined
  try {
    const decoded = decodeCbor(bytes).value
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined
    return decoded as Record<string, unknown>
  } catch {
    return undefined
  }
}

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function keyName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined
  return value
}

function requireCdpLane(lane: BrowserLaneRecord): void {
  if (lane.kind === 'human_embedded')
    throw Object.assign(
      new Error('the packaged CEF BrowserView/CDP handle is not exposed by Electrobun'),
      { code: 'capability_unavailable' }
    )
}

/** Selectors are DATA, never code: they are embedded into a
 *  \`Runtime.evaluate\` expression by the transport, so anything outside the
 *  CSS-selector grammar's inert characters is refused before it can reach a
 *  JS-string context. Backslash, backtick, braces, angle brackets, and
 *  control characters have no business in an Adea-issued selector and are the
 *  classic expression-breakout characters. */
const SAFE_SELECTOR = /^[A-Za-z0-9_\-#.[\]="'',:;()>*~+^$|\s]+$/

function assertSafeSelector(selector: string): string {
  if (selector.length === 0 || selector.length > 512 || !SAFE_SELECTOR.test(selector)) {
    throw Object.assign(new Error('selector contains characters outside the safe grammar'), {
      code: 'invalid_argument',
    })
  }
  return selector
}

async function inspectFrame(
  view: BrowserWebView,
  laneId: string,
  frame: FrameState,
  selector: string
): Promise<
  Readonly<{
    nodeId?: string
    role?: string
    name?: string
    bounds?: { x: number; y: number; width: number; height: number }
  }>
> {
  const world = await view.cdp<{ executionContextId?: number }>('Page.createIsolatedWorld', {
    frameId: frame.id,
    worldName: `adea-picker-${laneId}`,
    grantUniveralAccess: false,
  })
  if (typeof world.executionContextId !== 'number') return {}
  const selected = await view.cdp<{ result?: { objectId?: string } }>('Runtime.evaluate', {
    contextId: world.executionContextId,
    expression: `document.querySelector(${JSON.stringify(assertSafeSelector(selector))})`,
    returnByValue: false,
  })
  const objectId = selected.result?.objectId
  if (!objectId) return {}
  try {
    const node = await view.cdp<{ nodeId?: number }>('DOM.requestNode', { objectId })
    const description = await view.cdp<{
      result?: {
        value?: {
          role?: string
          name?: string
          bounds?: { x: number; y: number; width: number; height: number }
        }
      }
    }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () {
        const rect = this.getBoundingClientRect();
        return {
          role: this.getAttribute('role') || this.tagName.toLowerCase(),
          name: this.getAttribute('aria-label') || this.textContent?.trim()?.slice(0, 2048) || '',
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      }`,
      returnByValue: true,
    })
    const value = description.result?.value
    return {
      ...(typeof node.nodeId === 'number' ? { nodeId: String(node.nodeId) } : {}),
      ...(value?.role ? { role: value.role } : {}),
      ...(value?.name !== undefined ? { name: value.name } : {}),
      ...(value?.bounds ? { bounds: value.bounds } : {}),
    }
  } finally {
    await view.cdp('Runtime.releaseObject', { objectId }).catch(() => undefined)
  }
}

export function createBunWebViewLaneEngine(
  options: BunWebViewLaneEngineOptions = {}
): LaneEngine & {
  attachStream(session: BrowserFrameStream): void
  close(lane: BrowserLaneRecord): void
  generationChanged(laneId: string, generation: number): void
} {
  const factory = options.webViewFactory ?? defaultFactory
  const dataDir = options.dataDir ?? process.env.ADEA_DATA_DIR ?? DEFAULT_DATA_DIR
  const now = options.now ?? (() => Date.now())
  const lanes = new Map<string, LaneState>()
  const profileOwners = new Map<string, string>()

  function diagnostic(laneId: string, value: BrowserEngineDiagnostic): void {
    options.onDiagnostic?.(laneId, value)
  }

  function directoryFor(lane: BrowserLaneRecord): string {
    return browserLaneProfileDirectory(lane, dataDir)
  }

  function profileDirectory(lane: BrowserLaneRecord): string {
    const directory = directoryFor(lane)
    const owner = profileOwners.get(directory)
    if (owner && owner !== lane.id)
      throw Object.assign(new Error('browser profile is already attached to another live lane'), {
        code: 'capability_unavailable',
      })
    profileOwners.set(directory, lane.id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  function currentGeneration(state: LaneState): number {
    return options.laneGeneration?.(state.lane.id) ?? state.lane.generation
  }

  function ensureGeneration(state: LaneState): boolean {
    const generation = currentGeneration(state)
    if (generation === state.lane.generation) return true
    closeSubscribers(state, 'stale_generation', 'browser lane generation changed')
    return false
  }

  async function ackScreencast(state: LaneState, data: Record<string, unknown>): Promise<void> {
    const sessionId = data.sessionId
    if (typeof sessionId !== 'number' && typeof sessionId !== 'string') return
    try {
      await state.view.cdp('Page.screencastFrameAck', { sessionId })
    } catch (error) {
      diagnostic(state.lane.id, {
        level: 'warning',
        category: 'crash',
        message: `browser screencast acknowledgement failed: ${messageFrom(error)}`,
      })
    }
  }

  function publishFrame(state: LaneState, data: Record<string, unknown>): void {
    const encoded = data.data
    if (typeof encoded !== 'string' || !ensureGeneration(state)) return
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(Buffer.from(encoded, 'base64'))
    } catch {
      diagnostic(state.lane.id, {
        level: 'warning',
        category: 'network',
        message: 'browser screencast frame was not valid base64',
      })
      return
    }
    if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) return
    state.frameSequence += 1n
    const metadata = data.metadata
    const keyframe = Boolean(
      metadata && typeof metadata === 'object' && (metadata as { isKeyFrame?: unknown }).isKeyFrame
    )
    const frame = {
      sequence: state.frameSequence.toString(10),
      generation: state.lane.generation,
      viewportSequence: state.viewportSequence,
      keyframe,
      bytes,
    }
    for (const subscriber of state.subscribers) {
      if (subscriber.session.grant.resource.generation !== state.lane.generation) {
        removeSubscriber(state, subscriber)
        try {
          subscriber.session.close('stale_generation', 'browser lane generation changed')
        } catch {
          // Closed socket.
        }
        continue
      }
      subscriber.pacer.publish(frame)
    }
  }

  async function handleInput(
    state: LaneState,
    subscriber: Subscriber,
    frame: DevStreamFrame
  ): Promise<void> {
    if (frame.type !== 'input' && frame.type !== 'resize') return
    if (!ensureGeneration(state)) return
    if (frame.type === 'resize') {
      if (frame.cols < 1 || frame.rows < 1 || frame.cols > 4096 || frame.rows > 4096) return
      await state.view.resize(frame.cols, frame.rows)
      state.viewportSequence += 1
      return
    }
    const value = inputObject(frame.bytes)
    if (!value) return
    const kind = value.kind
    if (kind === 'click' && finite(value.x, 0, 4096) && finite(value.y, 0, 4096)) {
      await state.view.click(value.x, value.y)
      return
    }
    if (kind === 'scroll' && finite(value.dx, -4096, 4096) && finite(value.dy, -4096, 4096)) {
      await state.view.scroll(value.dx, value.dy)
      return
    }
    if (kind === 'type' && typeof value.text === 'string' && value.text.length <= MAX_TEXT_INPUT) {
      await state.view.type(value.text)
      return
    }
    if (kind === 'key') {
      const key = keyName(value.key)
      if (!key) return
      if (key === 'Escape') options.onEscape?.(state.lane.id)
      await state.view.press(key)
      return
    }
    void subscriber
  }

  async function startScreencast(state: LaneState): Promise<void> {
    if (state.screencastStarted || state.subscribers.size === 0) return
    state.screencastStarted = true
    try {
      await state.view.cdp('Page.startScreencast', {
        format: 'png',
        quality: 80,
        maxWidth: state.lane.viewport.width,
        maxHeight: state.lane.viewport.height,
        everyNthFrame: 1,
      })
    } catch (error) {
      state.screencastStarted = false
      diagnostic(state.lane.id, {
        level: 'error',
        category: 'crash',
        message: `browser screencast could not start: ${messageFrom(error)}`,
      })
      closeSubscribers(state, 'incompatible', 'browser screencast unavailable')
    }
  }

  function wireEvents(state: LaneState): void {
    state.view.addEventListener('Fetch.requestPaused', (event) => {
      void handlePausedRequest(state, event.data)
    })
    state.view.addEventListener('Page.screencastFrame', (event) => {
      const data = event.data
      if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>
        void ackScreencast(state, record)
        publishFrame(state, record)
      }
    })
    state.view.addEventListener('Page.frameNavigated', (event) => {
      const data = event.data
      const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
      const frame =
        record.frame && typeof record.frame === 'object'
          ? (record.frame as Record<string, unknown>)
          : undefined
      const id = frame?.id
      const url = frame?.url
      if (!frame || typeof id !== 'string' || typeof url !== 'string') return
      const parentId = typeof frame.parentId === 'string' ? frame.parentId : undefined
      if (!parentId) state.rootFrameId = id
      else
        state.frames.set(id, {
          id,
          parentId,
          url,
          title: typeof frame.name === 'string' ? frame.name : '',
        })
    })
    state.view.addEventListener('Page.frameDetached', (event) => {
      const data = event.data
      const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
      const id = record.frameId
      if (typeof id !== 'string') return
      state.frames.delete(id)
      for (const frame of state.frames.values())
        if (frame.parentId === id) state.frames.delete(frame.id)
    })
    state.view.addEventListener('Runtime.consoleAPICalled', (event) => {
      const data = event.data
      const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
      const type = typeof record.type === 'string' ? record.type : 'log'
      const args = Array.isArray(record.args) ? record.args.map(messageFrom).join(' ') : ''
      diagnostic(state.lane.id, {
        level: type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info',
        category: 'console',
        message: `${type}: ${args}`.slice(0, 4096),
      })
    })
    state.view.addEventListener('Network.loadingFailed', (event) => {
      const data = event.data
      const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
      diagnostic(state.lane.id, {
        level: 'error',
        category: 'network',
        message: `network request failed: ${messageFrom(record.errorText ?? 'unknown error')}`,
      })
    })
  }

  async function handlePausedRequest(state: LaneState, value: unknown): Promise<void> {
    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    const request =
      record.request && typeof record.request === 'object'
        ? (record.request as Record<string, unknown>)
        : {}
    const requestId = record.requestId
    const url = request.url
    if (typeof requestId !== 'string' || typeof url !== 'string') return
    const resourceType = record.resourceType
    if (resourceType !== undefined && resourceType !== 'Document') {
      try {
        await state.view.cdp('Fetch.continueRequest', { requestId })
      } catch {
        // The navigation may have ended while the subrequest was paused.
      }
      return
    }
    const navigation = state.navigation
    if (!navigation) {
      try {
        await state.view.cdp('Fetch.failRequest', { requestId, errorReason: 'Aborted' })
      } catch {
        // The view may have closed.
      }
      return
    }
    let admission: LaneHopAdmission
    try {
      admission = await navigation.hooks.admitHop(url)
    } catch {
      admission = {
        allowed: false,
        code: 'navigation_blocked',
        reason: 'navigation admission failed',
      }
    }
    if (!admission.allowed) {
      navigation.refused = { code: admission.code, reason: admission.reason }
      diagnostic(state.lane.id, { level: 'warning', category: 'policy', message: admission.reason })
      try {
        await state.view.cdp('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
      } catch {
        // The browser can close before the fail command is delivered.
      }
      return
    }
    navigation.hops.push({
      url: admission.normalizedUrl,
      status: Number(record.responseStatusCode) || 200,
    })
    try {
      await state.view.cdp('Fetch.continueRequest', {
        requestId,
        // Chromium follows the exact URL admitted by the provider. The
        // provider's pinned address ledger remains the source of truth for
        // redirect policy; engines without request interception are rejected.
        url: admission.normalizedUrl,
      })
    } catch (error) {
      navigation.refused = { code: 'navigation_blocked', reason: messageFrom(error) }
    }
  }

  async function refreshFrameTree(state: LaneState): Promise<void> {
    const result = await state.view.cdp<{
      frameTree?: {
        frame?: { id?: string; url?: string; name?: string }
        childFrames?: unknown[]
      }
    }>('Page.getFrameTree')
    const tree = result.frameTree
    if (!tree?.frame || typeof tree.frame.id !== 'string' || typeof tree.frame.url !== 'string')
      return
    state.rootFrameId = tree.frame.id
    const frames = new Map<string, FrameState>()
    const visit = (entry: unknown, parentId?: string): void => {
      if (!entry || typeof entry !== 'object') return
      const item = entry as {
        frame?: { id?: string; url?: string; name?: string }
        childFrames?: unknown[]
      }
      const frame = item.frame
      if (!frame || typeof frame.id !== 'string' || typeof frame.url !== 'string') return
      if (parentId)
        frames.set(frame.id, {
          id: frame.id,
          parentId,
          url: frame.url,
          title: typeof frame.name === 'string' ? frame.name : '',
        })
      for (const child of item.childFrames ?? []) visit(child, frame.id)
    }
    visit(tree)
    state.frames = frames
  }

  async function stateFor(lane: BrowserLaneRecord): Promise<LaneState> {
    const existing = lanes.get(lane.id)
    if (existing) {
      // The registry owns the generation and state. A takeover/release can
      // update that record while the WebView stays alive; keep the engine's
      // immutable identity fields and refresh the authoritative record.
      existing.lane = lane
      return existing
    }
    // An injected factory owns its own failure semantics. The default path
    // must refuse typed-unavailable BEFORE any profile directory is created
    // or leased, so an environmental absence never surfaces as the bare
    // factory TypeError (which the provider would misclassify as crash_loop)
    // and never strands a profile lease behind it.
    const backendReady =
      options.webViewFactory !== undefined ||
      (options.webViewBackendProbe ?? probeBunWebViewBackend)()
    if (!backendReady)
      throw Object.assign(
        new Error('this host does not provide the headless WebView backend browser lanes require'),
        { code: 'capability_unavailable' }
      )
    const directory = profileDirectory(lane)
    let view: BrowserWebView
    try {
      view = factory({
        width: lane.viewport.width,
        height: lane.viewport.height,
        headless: true,
        backend: { type: 'chrome', url: false, argv: ['--disable-background-networking'] },
        dataStore: { directory },
        console: (type, ...args) => {
          diagnostic(lane.id, {
            level: type === 'error' ? 'error' : type === 'warn' ? 'warning' : 'info',
            category: 'console',
            message: `${type}: ${args.map(messageFrom).join(' ')}`.slice(0, 4096),
          })
        },
      })
    } catch (error) {
      profileOwners.delete(directory)
      throw error
    }
    const created: LaneState = {
      lane,
      view,
      targetId: `browser-target-${lane.id}`,
      viewportSequence: 1,
      frameSequence: 0n,
      screencastStarted: false,
      subscribers: new Set(),
      frames: new Map(),
    }
    lanes.set(lane.id, created)
    wireEvents(created)
    try {
      await prepareBrowserView(created.view)
    } catch (error) {
      lanes.delete(lane.id)
      profileOwners.delete(directory)
      try {
        created.view.close()
      } catch {
        // A partially initialized view may already be gone.
      }
      throw error
    }
    return created
  }

  const engine: LaneEngine & {
    attachStream(session: BrowserFrameStream): void
    close(lane: BrowserLaneRecord): void
    generationChanged(laneId: string, generation: number): void
  } = {
    targets(lane) {
      requireCdpLane(lane)
      const state = lanes.get(lane.id)
      const page = {
        id: state?.targetId ?? `browser-target-${lane.id}`,
        type: 'page' as const,
        url: state?.view.url ?? 'about:blank',
        title: state?.view.title ?? '',
      }
      const frames = state
        ? [...state.frames.values()].map((frame) => ({
            id: frameTargetId(lane.id, frame.id),
            type: 'frame' as const,
            url: frame.url,
            title: frame.title,
          }))
        : []
      return [page, ...frames]
    },

    async screenshot(lane, input) {
      requireCdpLane(lane)
      const state = await stateFor(lane)
      const bytes = await state.view.screenshot({
        encoding: 'buffer',
        format: input.format,
        ...(input.quality === undefined ? {} : { quality: input.quality }),
      })
      return {
        bytes: new Uint8Array(bytes),
        width: lane.viewport.width,
        height: lane.viewport.height,
      }
    },

    async inspect(lane, input) {
      requireCdpLane(lane)
      const state = await stateFor(lane)
      const selector = input.selector ?? 'body'
      const frame = [...state.frames.values()].find(
        (candidate) => frameTargetId(lane.id, candidate.id) === input.targetId
      )
      if (frame) return inspectFrame(state.view, lane.id, frame, selector)
      if (input.targetId !== state.targetId) return {}
      try {
        const document = await state.view.cdp<{ root: { nodeId: number } }>('DOM.getDocument', {
          depth: 1,
          pierce: true,
        })
        const found = await state.view.cdp<{ nodeId: number }>('DOM.querySelector', {
          nodeId: document.root.nodeId,
          selector,
        })
        if (!found.nodeId) return {}
        const described = await state.view.cdp<{ node?: { attributes?: string[] } }>(
          'DOM.describeNode',
          {
            nodeId: found.nodeId,
          }
        )
        const box = await state.view.cdp<{ model?: { border?: number[]; content?: number[] } }>(
          'DOM.getBoxModel',
          {
            nodeId: found.nodeId,
          }
        )
        const attributes = described.node?.attributes ?? []
        const roleIndex = attributes.indexOf('role')
        const ariaIndex = attributes.indexOf('aria-label')
        const role = roleIndex >= 0 ? attributes[roleIndex + 1] : undefined
        const ariaLabel = ariaIndex >= 0 ? attributes[ariaIndex + 1] : undefined
        const value = await state.view.cdp<{ result?: { value?: { text?: string } } }>(
          'Runtime.evaluate',
          {
            expression: `(() => { const e = document.querySelector(${JSON.stringify(assertSafeSelector(selector))}); return { text: e?.textContent?.trim()?.slice(0,2048) ?? '' } })()`,
            returnByValue: true,
          }
        )
        return {
          nodeId: String(found.nodeId),
          ...(role ? { role } : {}),
          name: ariaLabel ?? value.result?.value?.text ?? '',
          ...(boundsFromQuad(box.model?.border ?? box.model?.content)
            ? { bounds: boundsFromQuad(box.model?.border ?? box.model?.content) }
            : {}),
        }
      } catch {
        return {}
      }
    },

    async navigate(lane, url, hooks): Promise<LaneNavigationOutcome> {
      requireCdpLane(lane)
      const state = await stateFor(lane)
      const navigation: NavigationState = { hooks, hops: [] }
      state.navigation = navigation
      try {
        // The provider has already admitted the requested URL. Fetch.requestPaused
        // is the engine's second sight of that initial hop and the first point
        // at which Chromium can be continued, so the listener below re-runs the
        // gate before any request leaves the browser process. Calling the hook
        // here as well would turn the provider's intentional initial re-check
        // into a false redirect-loop refusal.
        await state.view.navigate(url)
        await refreshFrameTree(state)
      } catch (error) {
        if (navigation.refused)
          throw Object.assign(new Error(navigation.refused.reason), navigation.refused)
        throw Object.assign(new Error('browser navigation failed'), {
          code: 'crash_loop',
          cause: error,
        })
      } finally {
        state.navigation = undefined
      }
      if (navigation.refused)
        throw Object.assign(new Error(navigation.refused.reason), navigation.refused)
      if (navigation.hops.length === 0)
        throw Object.assign(
          new Error('browser engine did not expose the CDP request interception boundary'),
          { code: 'capability_unavailable' }
        )
      const finalUrl = navigation.hops.at(-1)?.url ?? state.view.url ?? url
      return {
        targetId: state.targetId,
        finalUrl,
        status: navigation.hops.at(-1)?.status,
        hops: navigation.hops.length > 0 ? navigation.hops : [{ url: finalUrl, status: 200 }],
      }
    },

    async applyViewport(lane, viewport: LaneViewport): Promise<void> {
      requireCdpLane(lane)
      const state = await stateFor(lane)
      await state.view.resize(viewport.width, viewport.height)
      await state.view.cdp('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: viewport.mobile,
      })
      state.viewportSequence += 1
      if (state.screencastStarted)
        await state.view.cdp('Page.startScreencast', {
          format: 'png',
          quality: 80,
          maxWidth: viewport.width,
          maxHeight: viewport.height,
          everyNthFrame: 1,
        })
    },

    attachStream(session) {
      const laneId = session.grant.resource.id
      const lane = options.laneLookup?.(laneId) ?? lanes.get(laneId)?.lane
      if (!lane || session.grant.resource.generation !== lane.generation) {
        session.close('stale_generation', 'browser lane generation changed')
        return
      }
      let closed = false
      let cleanup: (() => void) | undefined
      session.onClose = () => {
        closed = true
        cleanup?.()
      }
      const attachToState = (state: LaneState): void => {
        if (closed) return
        if (
          !ensureGeneration(state) ||
          session.grant.resource.generation !== state.lane.generation
        ) {
          session.close('stale_generation', 'browser lane generation changed')
          return
        }
        let subscriber: Subscriber
        subscriber = {
          session,
          creditBytes: session.grant.maxFrameBytes,
          pacer: createLaneScreencast({
            onFrame: (frame) => {
              if (subscriber.creditBytes < frame.bytes.byteLength) return
              subscriber.creditBytes -= frame.bytes.byteLength
              try {
                session.send({
                  type: 'video',
                  sequence: frame.sequence,
                  timestampMs: now(),
                  keyframe: frame.keyframe,
                  bytes: frame.bytes,
                })
              } catch {
                removeSubscriber(state, subscriber)
              }
            },
          }),
        }
        state.subscribers.add(subscriber)
        cleanup = () => {
          if (!cleanup) return
          cleanup = undefined
          removeSubscriber(state, subscriber)
        }
        session.onFrame = (frame) => {
          if (frame.type === 'ack') {
            subscriber.creditBytes = frame.availableCreditBytes
            subscriber.pacer.ack(frame.throughSequence, subscriber.creditBytes > 0 ? 1 : 0)
          } else if (frame.type === 'input' || frame.type === 'resize') {
            void handleInput(state, subscriber, frame).catch((error) => {
              diagnostic(state.lane.id, {
                level: 'warning',
                category: 'network',
                message: messageFrom(error),
              })
            })
          }
        }
        void startScreencast(state)
      }
      const existing = lanes.get(laneId)
      if (existing) {
        // Keep the already-provisioned path synchronous so an input frame
        // arriving in the same turn as attach cannot be dropped.
        existing.lane = lane
        attachToState(existing)
        return
      }
      // A stream may be attached immediately after laneCreate, before the
      // first navigate/screenshot call has provisioned the view. Provision
      // that view here instead of misclassifying a valid grant as stale.
      void stateFor(lane)
        .then((state) => {
          const current = options.laneLookup?.(laneId) ?? state.lane
          if (!current || session.grant.resource.generation !== current.generation) {
            session.close('stale_generation', 'browser lane generation changed')
            return
          }
          state.lane = current
          attachToState(state)
        })
        .catch((error) => {
          if (closed) return
          diagnostic(laneId, {
            level: 'error',
            category: 'crash',
            message: `browser stream setup failed: ${messageFrom(error)}`,
          })
          session.close('incompatible', 'browser stream setup unavailable')
        })
    },

    close(lane) {
      const state = lanes.get(lane.id)
      if (!state) return
      closeSubscribers(state, 'normal', 'browser lane closed')
      try {
        state.view.close()
      } catch {
        // Closing a crashed view is idempotent.
      }
      profileOwners.delete(directoryFor(lane))
      lanes.delete(lane.id)
    },

    generationChanged(laneId, generation) {
      const state = lanes.get(laneId)
      if (!state || state.lane.generation === generation) return
      closeSubscribers(state, 'stale_generation', 'browser lane generation changed')
    },
  }
  return engine
}
