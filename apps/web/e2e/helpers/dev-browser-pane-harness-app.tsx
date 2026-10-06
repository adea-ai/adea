import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

import {
  applyAppearanceFontSettings,
  DEFAULT_APPEARANCE_EDITOR_FONT_SETTINGS,
  type AppearanceEditorFontSettings,
} from '@adea-ai/ui/lib/appearance-font-settings'

import { BrowserPane } from '../../../../packages/dev-view/src/browser/browser-pane'
import { DevicesPane } from '../../../../packages/dev-view/src/devices/devices-pane'
import { DevLayoutView } from '../../../../packages/dev-view/src/layout/layout-view'
import { createLayoutState } from '../../../../packages/dev-view/src/layout/operations'
import { ResourcesPane } from '../../../../packages/dev-view/src/resources/resources-pane'
import type { DevRuntimeService } from '../../../../packages/dev-view/src/platform'
import {
  browserPaneFixtureScope,
  cookieFixtureMode,
  cookieImportCommitReply,
  cookieImportPlanReply,
  cookieSourcesReply,
  type CookieFixtureLane,
} from './dev-browser-pane-cookie-fixtures'
import { Button } from '@adea-ai/ui/components/ui/button'
import type {
  BrowserLane,
  BrowserTarget,
  DevCommand,
  DevError,
  DevReply,
  PortRecord,
  ResourceSnapshot,
  ScreenshotRef,
} from '@adea-ai/types/dev-runtime'

import type { BrowserPaneHarnessReport } from './dev-browser-pane-harness'
import type { DevUtilityContextReader } from '../../../../packages/dev-view/src/utility-context'

const scope = browserPaneFixtureScope
let lane: BrowserLane = {
  id: 'browser-pane-fixture-lane',
  scope,
  runtimeSessionId: 'browser-pane-fixture-session',
  kind: 'task_owned',
  profileId: 'browser-pane-fixture-profile',
  state: 'ready',
  automationOwner:
    new URLSearchParams(window.location.search).get('owner') === 'agent'
      ? 'agent'
      : 'human_takeover',
  generation: 7,
}
const alternateLane: BrowserLane = {
  ...lane,
  id: 'browser-pane-fixture-lane-2',
  profileId: 'browser-pane-fixture-profile-2',
  generation: 9,
}
const previewUrl = 'http://localhost:5173/nested/page?mode=preview#details'
let currentUrl = 'http://localhost:5173/initial'
const commands: DevCommand[] = []
let screenshotSequence = 0
let nextDeferredScreenshotId: number | undefined
let nextScreenshotError: DevError | undefined
let deferredInventory: { command: DevCommand; resolve(reply: DevReply): void } | undefined
let deferNextLaneList = false
let deferredLaneList: { command: DevCommand; resolve(reply: DevReply): void } | undefined
let nextLaneControlError: DevError | undefined
const deferredScreenshots = new Map<
  number,
  { command: DevCommand; resolve(reply: DevReply): void }
>()
let nextDeferredScreenshotSequence = 0
let nextDeferredViewportSequence = 0
const deferredViewports = new Map<number, { command: DevCommand; resolve(reply: DevReply): void }>()
const queuedViewportIds: number[] = []
let nextDeferredAnnotateSequence = 0
let nextDeferredAnnotateId: number | undefined
const deferredAnnotations = new Map<
  number,
  { command: DevCommand; resolve(reply: DevReply): void }
>()
let nextDeferredCookiePlanId: number | undefined
let nextDeferredCookiePlanSequence = 0
const deferredCookiePlans = new Map<
  number,
  {
    command: DevCommand
    lane: CookieFixtureLane
    mode: ReturnType<typeof cookieFixtureMode>
    resolve(reply: DevReply): void
  }
>()
let nextDeferredCookieCommitId: number | undefined
let nextDeferredCookieCommitSequence = 0
const deferredCookieCommits = new Map<
  number,
  {
    command: DevCommand
    lane: CookieFixtureLane
    mode: ReturnType<typeof cookieFixtureMode>
    resolve(reply: DevReply): void
  }
>()
const initialSessionId = lane.runtimeSessionId
const [canonicalSession, setCanonicalSession] = createSignal({
  runtimeSessionId: initialSessionId,
  sessionGeneration: 7,
  revision: 1,
})

function browserLanes(): readonly BrowserLane[] {
  return new URLSearchParams(window.location.search).get('lanes') === 'multiple'
    ? [lane, alternateLane]
    : [lane]
}

function cookiesFixtureMode() {
  return cookieFixtureMode(new URLSearchParams(window.location.search))
}

function cookieLaneSnapshot(): CookieFixtureLane {
  return { id: lane.id, generation: lane.generation, state: lane.state }
}

const port: PortRecord = {
  id: 'browser-pane-fixture-port',
  scope,
  protocol: 'tcp',
  host: 'localhost',
  port: 5173,
  owner: 'adea',
  runtimeSessionId: lane.runtimeSessionId,
  preview: { browserLaneId: lane.id, url: previewUrl },
  state: 'observed',
  observedAt: new Date(0).toISOString(),
}

function reply(command: DevCommand, value: unknown): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    value,
    observedAt: new Date(0).toISOString(),
  } as DevReply
}

function errorReply(command: DevCommand, error: DevError): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: false,
    error,
    observedAt: new Date(0).toISOString(),
  } as DevReply
}

function screenshotRef(id?: string): ScreenshotRef {
  screenshotSequence += 1
  return {
    id: id ?? `00000000-0000-4000-8000-${String(screenshotSequence).padStart(12, '0')}`,
    scope,
    ownerId: 'browser-pane-fixture-owner',
    laneKind: lane.kind,
    profileId: lane.profileId,
    origin: 'http://localhost:5173',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    redacted: false,
    contentType: 'image/png',
    byteLength: '12345',
    width: 1280,
    height: 720,
    sha256: '0'.repeat(64),
    expiresAt: '2099-01-02T03:04:05.000Z',
  }
}

const deferredControls = {
  deferNextScreenshot(): number {
    nextDeferredScreenshotSequence += 1
    nextDeferredScreenshotId = nextDeferredScreenshotSequence
    return nextDeferredScreenshotSequence
  },
  resolveScreenshot(requestId: number, reference: ScreenshotRef): void {
    const pending = deferredScreenshots.get(requestId)
    if (!pending) throw new Error(`deferred screenshot ${requestId} is not pending`)
    deferredScreenshots.delete(requestId)
    pending.resolve(reply(pending.command, reference))
  },
  rejectScreenshot(requestId: number, error: DevError): void {
    const pending = deferredScreenshots.get(requestId)
    if (!pending) throw new Error(`deferred screenshot ${requestId} is not pending`)
    deferredScreenshots.delete(requestId)
    pending.resolve(errorReply(pending.command, error))
  },
  failNextScreenshot(error: DevError): void {
    nextScreenshotError = error
  },
  deferLaneListRefresh(): void {
    deferNextLaneList = true
  },
  resolvePendingLaneList(): void {
    if (!deferredLaneList) throw new Error('lane list refresh is not pending')
    const { command, resolve } = deferredLaneList
    deferredLaneList = undefined
    resolve(reply(command, { items: browserLanes() }))
  },
  failNextLaneControl(error: DevError): void {
    nextLaneControlError = error
  },
  deferNextViewport(): number {
    nextDeferredViewportSequence += 1
    queuedViewportIds.push(nextDeferredViewportSequence)
    return nextDeferredViewportSequence
  },
  resolveViewport(requestId: number): void {
    const pending = deferredViewports.get(requestId)
    if (!pending) throw new Error(`deferred viewport ${requestId} is not pending`)
    deferredViewports.delete(requestId)
    pending.resolve(reply(pending.command, {}))
  },
  rejectViewport(requestId: number, error: DevError): void {
    const pending = deferredViewports.get(requestId)
    if (!pending) throw new Error(`deferred viewport ${requestId} is not pending`)
    deferredViewports.delete(requestId)
    pending.resolve(errorReply(pending.command, error))
  },
  advanceLaneGeneration(): void {
    lane = { ...lane, generation: lane.generation + 1 }
  },
  deferNextAnnotate(): number {
    nextDeferredAnnotateSequence += 1
    nextDeferredAnnotateId = nextDeferredAnnotateSequence
    return nextDeferredAnnotateSequence
  },
  deferNextCookiePlan(): number {
    nextDeferredCookiePlanSequence += 1
    nextDeferredCookiePlanId = nextDeferredCookiePlanSequence
    return nextDeferredCookiePlanSequence
  },
  resolveCookiePlan(requestId: number): void {
    const pending = deferredCookiePlans.get(requestId)
    if (!pending) throw new Error(`deferred cookie plan ${requestId} is not pending`)
    deferredCookiePlans.delete(requestId)
    pending.resolve(cookieImportPlanReply(pending.command, pending.lane, pending.mode))
  },
  deferNextCookieCommit(): number {
    nextDeferredCookieCommitSequence += 1
    nextDeferredCookieCommitId = nextDeferredCookieCommitSequence
    return nextDeferredCookieCommitSequence
  },
  resolveCookieCommit(requestId: number): void {
    const pending = deferredCookieCommits.get(requestId)
    if (!pending) throw new Error(`deferred cookie commit ${requestId} is not pending`)
    deferredCookieCommits.delete(requestId)
    pending.resolve(cookieImportCommitReply(pending.command, pending.lane, pending.mode))
  },
  switchSession(): void {
    setCanonicalSession((current) => {
      const runtimeSessionId =
        current.runtimeSessionId === initialSessionId
          ? 'browser-pane-fixture-session-2'
          : initialSessionId
      lane = { ...lane, runtimeSessionId }
      return {
        runtimeSessionId,
        sessionGeneration: current.sessionGeneration + 1,
        revision: current.revision + 1,
      }
    })
  },
  resolveAnnotate(requestId: number, value: unknown): void {
    const pending = deferredAnnotations.get(requestId)
    if (!pending) throw new Error(`deferred annotation ${requestId} is not pending`)
    deferredAnnotations.delete(requestId)
    pending.resolve(reply(pending.command, value))
  },
  rejectAnnotate(requestId: number, error: DevError): void {
    const pending = deferredAnnotations.get(requestId)
    if (!pending) throw new Error(`deferred annotation ${requestId} is not pending`)
    deferredAnnotations.delete(requestId)
    pending.resolve(errorReply(pending.command, error))
  },
  closeFixtureLane(): void {
    // Mirrors the registry's close: the state flips, ownership drops, and the
    // generation stays — the pane's cached binding remains the truth.
    lane = { ...lane, state: 'closed', automationOwner: 'none' }
  },
}

const runtime = {
  state: () => ({ status: 'ready' as const }),
  preferenceScope: () => scope,
  execute: async (command: DevCommand) => {
    commands.push(command)
    switch (command.operation) {
      case 'dev.browser.lanes':
        if (deferNextLaneList) {
          deferNextLaneList = false
          return await new Promise<DevReply>((resolve) => {
            deferredLaneList = { command, resolve }
          })
        }
        return reply(command, { items: browserLanes() })
      case 'dev.browser.targets': {
        const worker: BrowserTarget = {
          id: 'browser-pane-fixture-worker',
          browserLaneId: lane.id,
          type: 'worker',
          url: 'https://worker.example.invalid',
          title: 'Browser pane service worker',
          generation: lane.generation,
        }
        const target: BrowserTarget = {
          id: 'browser-pane-fixture-target',
          browserLaneId: lane.id,
          type: 'page',
          url: currentUrl,
          title: 'Browser pane fixture',
          generation: lane.generation,
        }
        return reply(command, { items: [worker, target] })
      }
      case 'dev.resources.ports':
        return reply(command, { items: [port] })
      case 'dev.resources.snapshot':
        return reply(command, {
          processes: [
            {
              id: 'browser-pane-fixture-process',
              scope,
              runtimeSessionId: lane.runtimeSessionId,
              ownerKind: 'browser',
              ownerId: lane.id,
              pid: 4100,
              startIdentity: 'browser-pane-fixture-process-start',
              executableIdentity: 'browser-pane-fixture-browser',
              generation: lane.generation,
              state: 'running',
            },
          ],
          ports: [port],
          metrics: [],
          retainedData: [],
          observedAt: new Date(0).toISOString(),
        } satisfies ResourceSnapshot)
      case 'dev.resources.usage':
        return reply(command, { items: [] })
      case 'dev.device.list':
        if (new URLSearchParams(window.location.search).get('inventory') === 'failed') {
          return errorReply(command, {
            code: 'unavailable',
            message: 'fixture inventory read failed',
            retryable: true,
          })
        }
        if (new URLSearchParams(window.location.search).get('inventory') === 'pending') {
          return await new Promise<DevReply>((resolve) => {
            deferredInventory = { command, resolve }
          })
        }
        const simulatorInventory = {
          id: 'ios:probe-simulator',
          kind: 'ios_simulator',
          name: 'iPhone 16 Pro (iOS 18.2)',
          platform: 'ios',
          state: 'available',
          generation: 3,
          observedAt: new Date(0).toISOString(),
        } satisfies import('@adea-ai/types/dev-runtime').DeviceInventoryItem
        return reply(command, {
          items: [
            {
              id: 'adea:responsive',
              kind: 'responsive',
              name: 'Responsive viewport',
              platform: 'responsive',
              state: 'available',
              generation: 1,
              observedAt: new Date(0).toISOString(),
            },
            // `inventory=devices` adds a simulator row so the device-row
            // layout assertions have an action control to measure.
            ...(new URLSearchParams(window.location.search).get('inventory') === 'devices'
              ? [simulatorInventory]
              : []),
          ],
        })
      case 'dev.device.sessions':
        return reply(command, { items: [] })
      case 'dev.device.capabilities': {
        const available =
          new URLSearchParams(window.location.search).get('capabilities') === 'available'
        const observedAt = new Date(0).toISOString()
        return reply(command, {
          items: [
            {
              platform: 'ios',
              state: available ? 'available' : 'unavailable',
              ...(!available ? { missingPiece: 'xcrun_simctl' } : {}),
              observedAt,
            },
            { platform: 'android', state: 'available', observedAt },
          ],
          observedAt,
        })
      }
      case 'dev.browser.diagnostics':
        return reply(command, { items: [] })
      case 'dev.browser.cookieSources':
        return cookieSourcesReply(command, cookiesFixtureMode())
      case 'dev.browser.cookieImportPlan': {
        if (nextDeferredCookiePlanId !== undefined) {
          const requestId = nextDeferredCookiePlanId
          nextDeferredCookiePlanId = undefined
          const laneSnapshot = cookieLaneSnapshot()
          const mode = cookiesFixtureMode()
          return await new Promise<DevReply>((resolve) => {
            deferredCookiePlans.set(requestId, { command, lane: laneSnapshot, mode, resolve })
          })
        }
        return cookieImportPlanReply(command, lane, cookiesFixtureMode())
      }
      case 'dev.browser.cookieImportCommit': {
        if (nextDeferredCookieCommitId !== undefined) {
          const requestId = nextDeferredCookieCommitId
          nextDeferredCookieCommitId = undefined
          const laneSnapshot = cookieLaneSnapshot()
          const mode = cookiesFixtureMode()
          return await new Promise<DevReply>((resolve) => {
            deferredCookieCommits.set(requestId, { command, lane: laneSnapshot, mode, resolve })
          })
        }
        return cookieImportCommitReply(command, lane, cookiesFixtureMode())
      }
      case 'dev.browser.navigate': {
        const url = command.body.url
        if (typeof url === 'string') currentUrl = url
        return reply(command, {
          browserLaneId: lane.id,
          targetId: 'browser-pane-fixture-target',
          finalUrl: currentUrl,
          status: 200,
        })
      }
      case 'dev.browser.inspect':
        return reply(command, {
          targetId: 'browser-pane-fixture-target',
          nodeId: '42',
          role: 'button',
          name: 'Submit request',
          bounds: { x: 12, y: 24, width: 80, height: 32 },
          observedAt: new Date(0).toISOString(),
        })
      case 'dev.browser.screenshot': {
        if (nextScreenshotError) {
          const error = nextScreenshotError
          nextScreenshotError = undefined
          return errorReply(command, error)
        }
        if (nextDeferredScreenshotId !== undefined) {
          const requestId = nextDeferredScreenshotId
          nextDeferredScreenshotId = undefined
          return await new Promise<DevReply>((resolve) => {
            deferredScreenshots.set(requestId, { command, resolve })
          })
        }
        return reply(command, screenshotRef())
      }
      case 'dev.browser.viewport': {
        const requestId = queuedViewportIds.shift()
        if (requestId !== undefined) {
          return await new Promise<DevReply>((resolve) => {
            deferredViewports.set(requestId, { command, resolve })
          })
        }
        return reply(command, {})
      }
      case 'dev.browser.annotate': {
        if (nextDeferredAnnotateId !== undefined) {
          const requestId = nextDeferredAnnotateId
          nextDeferredAnnotateId = undefined
          return await new Promise<DevReply>((resolve) => {
            deferredAnnotations.set(requestId, { command, resolve })
          })
        }
        const annotation = command.body.annotation as {
          kind: string
          x: number
          y: number
          width?: number
          height?: number
          text?: string
        }
        return reply(command, {
          targetId: command.body.targetId,
          kind: annotation.kind,
          x: annotation.x,
          y: annotation.y,
          ...(annotation.width === undefined ? {} : { width: annotation.width }),
          ...(annotation.height === undefined ? {} : { height: annotation.height }),
          ...(annotation.text === undefined ? {} : { text: annotation.text }),
          id: '00000000-0000-4000-8000-00000000a001',
          screenshotId: '00000000-0000-4000-8000-00000000b002',
          createdAt: new Date(0).toISOString(),
        })
      }
      case 'dev.browser.takeover':
      case 'dev.browser.release': {
        if (nextLaneControlError) {
          const error = nextLaneControlError
          nextLaneControlError = undefined
          return errorReply(command, error)
        }
        lane = {
          ...lane,
          automationOwner: command.operation === 'dev.browser.release' ? 'agent' : 'human_takeover',
          generation: lane.generation + 1,
        }
        return reply(command, lane)
      }
      default:
        return reply(command, {})
    }
  },
} as unknown as DevRuntimeService

const utilityContext: DevUtilityContextReader = () => {
  const session = canonicalSession()
  return {
    view: 'dev',
    runtime,
    scope,
    projectId: 'browser-pane-fixture-project',
    runtimeSessionId: session.runtimeSessionId,
    sessionGeneration: session.sessionGeneration,
    worktreeId: 'browser-pane-fixture-worktree',
    revision: session.revision,
  }
}

let dispose: (() => void) | undefined

const harness = {
  setFonts(settings: AppearanceEditorFontSettings): void {
    applyAppearanceFontSettings(document.documentElement, settings)
  },
  resetFonts(): void {
    applyAppearanceFontSettings(document.documentElement, DEFAULT_APPEARANCE_EDITOR_FONT_SETTINGS)
  },
  report(): BrowserPaneHarnessReport {
    return {
      commands: commands.map(({ operation, body, resource }) => ({
        operation,
        body,
        ...(resource ? { resource } : {}),
      })),
    }
  },
  resolvePendingInventory(): void {
    if (!deferredInventory) throw new Error('device inventory request is not pending')
    const { command, resolve } = deferredInventory
    deferredInventory = undefined
    resolve(
      reply(command, {
        items: [
          {
            id: 'adea:responsive',
            kind: 'responsive',
            name: 'Responsive viewport',
            platform: 'responsive',
            state: 'available',
            generation: 1,
            observedAt: new Date(0).toISOString(),
          },
        ],
      })
    )
  },
  ...deferredControls,
  unmount(): void {
    dispose?.()
    dispose = undefined
  },
}

declare global {
  interface Window {
    browserPaneHarness: typeof harness
  }
}

const root = document.getElementById('harness-root')
if (!root) throw new Error('browser pane harness root missing')
const showContextControl =
  new URLSearchParams(window.location.search).get('context-control') === 'enabled'

dispose = render(() => {
  const pane = new URLSearchParams(window.location.search).get('pane')
  if (pane?.startsWith('layout-'))
    return (
      <DevLayoutView
        state={createLayoutState({
          kind: 'leaf',
          id: 'placeholder',
          pane: pane === 'layout-editor' ? 'editor' : 'terminal',
        })}
        unavailable={pane !== 'layout-terminal-available'}
        onClose={() => 'placeholder'}
        onFocus={() => {}}
        onResize={() => {}}
        onMoveTo={() => {}}
      />
    )
  return (
    <>
      {showContextControl && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => deferredControls.switchSession()}
          >
            Switch runtime session
          </Button>
          <output data-testid="canonical-session">{canonicalSession().runtimeSessionId}</output>
        </>
      )}
      {pane === 'devices' ? (
        <DevicesPane context={utilityContext} />
      ) : pane === 'resources' ? (
        <ResourcesPane runtime={runtime} runtimeSessionId={lane.runtimeSessionId} />
      ) : (
        <BrowserPane context={utilityContext} />
      )}
    </>
  )
}, root)
window.browserPaneHarness = harness
