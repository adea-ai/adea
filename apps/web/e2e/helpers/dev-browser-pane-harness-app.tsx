import { render } from 'solid-js/web'

import { BrowserPane } from '../../../../packages/dev-view/src/browser/browser-pane'
import type { DevRuntimeService } from '../../../../packages/dev-view/src/platform'
import type {
  BrowserLane,
  BrowserTarget,
  DevCommand,
  DevReply,
  PortRecord,
  Scope,
} from '@adea-ai/types/dev-runtime'

import type { BrowserPaneHarnessReport } from './dev-browser-pane-harness'

const scope: Scope = {
  accountId: 'browser-pane-fixture-account',
  workspaceId: 'browser-pane-fixture-workspace',
  runtimeNodeId: 'browser-pane-fixture-node',
}
const lane: BrowserLane = {
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
      default:
        return reply(command, {})
    }
  },
} as unknown as DevRuntimeService

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
}

declare global {
  interface Window {
    browserPaneHarness: typeof harness
  }
}

const root = document.getElementById('harness-root')
if (!root) throw new Error('browser pane harness root missing')

render(() => <BrowserPane runtime={runtime} runtimeSessionId={lane.runtimeSessionId} />, root)
window.browserPaneHarness = harness
