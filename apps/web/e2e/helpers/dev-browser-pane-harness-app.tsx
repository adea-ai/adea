import { render } from 'solid-js/web'

import { BrowserPane } from '../../../../packages/dev-view/src/browser/browser-pane'
import type { DevRuntimeService } from '../../../../packages/dev-view/src/platform'
import type {
  BrowserLane,
  BrowserTarget,
  DevCommand,
  DevError,
  DevReply,
  PortRecord,
  ScreenshotRef,
  Scope,
} from '@adea-ai/types/dev-runtime'

import type { BrowserPaneHarnessReport } from './dev-browser-pane-harness'

const scope: Scope = {
  accountId: 'browser-pane-fixture-account',
  workspaceId: 'browser-pane-fixture-workspace',
  runtimeNodeId: 'browser-pane-fixture-node',
}
let lane: BrowserLane = {
  id: 'browser-pane-fixture-lane',
  scope,
  runtimeSessionId: 'browser-pane-fixture-session',
  kind: 'task_owned',
  profileId: 'browser-pane-fixture-profile',
  state: 'ready',
  automationOwner: 'human_takeover',
  generation: 7,
}
const previewUrl = 'http://localhost:5173/nested/page?mode=preview#details'
let currentUrl = 'http://localhost:5173/initial'
const commands: DevCommand[] = []
let screenshotSequence = 0
let nextDeferredScreenshotId: number | undefined
let nextScreenshotError: DevError | undefined
const deferredScreenshots = new Map<
  number,
  { command: DevCommand; resolve(reply: DevReply): void }
>()
let nextDeferredScreenshotSequence = 0

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
}

const runtime = {
  state: () => ({ status: 'ready' as const }),
  preferenceScope: () => scope,
  execute: async (command: DevCommand) => {
    commands.push(command)
    switch (command.operation) {
      case 'dev.browser.lanes':
        return reply(command, { items: [lane] })
      case 'dev.browser.targets': {
        const target: BrowserTarget = {
          id: 'browser-pane-fixture-target',
          browserLaneId: lane.id,
          type: 'page',
          url: currentUrl,
          title: 'Browser pane fixture',
          generation: lane.generation,
        }
        return reply(command, { items: [target] })
      }
      case 'dev.resources.ports':
        return reply(command, { items: [port] })
      case 'dev.browser.diagnostics':
        return reply(command, { items: [] })
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
      case 'dev.browser.takeover':
      case 'dev.browser.release': {
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

let dispose: (() => void) | undefined

const harness = {
  report(): BrowserPaneHarnessReport {
    return {
      commands: commands.map(({ operation, body, resource }) => ({
        operation,
        body,
        ...(resource ? { resource } : {}),
      })),
    }
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

dispose = render(
  () => <BrowserPane runtime={runtime} runtimeSessionId={lane.runtimeSessionId} />,
  root
)
window.browserPaneHarness = harness
