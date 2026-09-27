import { describe, expect, test } from 'bun:test'

import type { HarnessRun } from '../../../packages/types/src/dev-runtime'
import {
  createHarnessRunNotificationPublisher,
  requestNativeChatNotification,
  type NativeNotificationRequest,
} from '../shell/src/notifications/harness-run-notifications'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const SESSION_ID = '00000000-0000-4000-8000-000000000010'

function run(state: HarnessRun['state'], version: number): HarnessRun {
  return {
    id: '00000000-0000-4000-8000-000000000020',
    scope: SCOPE,
    runtimeSessionId: SESSION_ID,
    installationId: '00000000-0000-4000-8000-000000000030',
    agentProfile: {
      id: '00000000-0000-4000-8000-000000000040',
      version: 1,
      displayName: 'Private harness name',
      capabilityPolicyVersion: 1,
    },
    state,
    generation: 1,
    version,
  }
}

describe('native harness notification requests', () => {
  test('sends only a fixed title and body, never intent identifiers or display data', () => {
    const requests: NativeNotificationRequest[] = []
    const intent = {
      id: 'private-run-id',
      kind: 'awaiting_input' as const,
      runtimeSessionId: 'private-session-id',
      title: '/Users/private/project/token=secret',
      body: 'Prompt: do not send this',
      generation: 41,
    }

    expect(
      requestNativeChatNotification(
        { showNotification: (request) => requests.push(request) },
        intent
      )
    ).toEqual({ status: 'requested' })
    expect(requests).toEqual([{ title: 'Adea', body: 'A conversation needs your attention.' }])
  })

  test('reports missing or throwing APIs as silent typed outcomes', () => {
    const intent = {
      id: 'run',
      kind: 'completed' as const,
      runtimeSessionId: SESSION_ID,
      title: 'Private title',
      body: 'Private body',
      generation: 1,
    }

    expect(requestNativeChatNotification(undefined, intent)).toEqual({
      status: 'unavailable',
      reason: 'api_missing',
    })
    expect(
      requestNativeChatNotification(
        {
          showNotification() {
            throw new Error('native failure')
          },
        },
        intent
      )
    ).toEqual({ status: 'unavailable', reason: 'request_failed' })
  })
})

describe('canonical run-status notification publisher', () => {
  test('seeds after composition, observes only run.status, and suppresses the focused session', () => {
    let current = [run('working', 2)]
    let focused = false
    let focusedSessionId: string | undefined
    const notifications: Array<{ kind: string; runtimeSessionId: string }> = []
    const publisher = createHarnessRunNotificationPublisher({
      readRuns: () => current,
      windowFocused: () => focused,
      focusedSessionId: () => focusedSessionId,
      request: (intent) => {
        notifications.push({ kind: intent.kind, runtimeSessionId: intent.runtimeSessionId })
      },
    })

    publisher.seed()
    current = [run('awaiting_input', 3)]
    publisher.onPublishedEvent('git.statusInvalidated')
    publisher.onPublishedEvent('run.status', { kind: 'run.status' })
    expect(notifications).toEqual([])
    publisher.onPublishedEvent('dev.harness.updated', { kind: 'git.statusInvalidated' })
    expect(notifications).toEqual([])
    publisher.onPublishedEvent('dev.harness.updated', { kind: 'run.status' })
    expect(notifications).toEqual([{ kind: 'awaiting_input', runtimeSessionId: SESSION_ID }])

    focused = true
    focusedSessionId = SESSION_ID
    current = [run('working', 4)]
    publisher.onPublishedEvent('dev.harness.updated', { kind: 'run.status' })
    current = [run('awaiting_approval', 5)]
    publisher.onPublishedEvent('dev.harness.updated', { kind: 'run.status' })
    expect(notifications).toHaveLength(1)

    focused = false
    focusedSessionId = undefined
    current = [run('working', 6)]
    publisher.onPublishedEvent('dev.harness.updated', { kind: 'run.status' })
    current = [run('completed', 7)]
    publisher.onPublishedEvent('dev.harness.updated', { kind: 'run.status' })
    expect(notifications.at(-1)).toEqual({ kind: 'completed', runtimeSessionId: SESSION_ID })

    publisher.dispose()
    current = [run('awaiting_input', 8)]
    publisher.onPublishedEvent('dev.harness.updated', { kind: 'run.status' })
    expect(notifications).toHaveLength(2)
  })

  test('advances its baseline even when the request callback throws', () => {
    let current = [run('working', 1)]
    let throwNext = true
    const notifications: string[] = []
    const publisher = createHarnessRunNotificationPublisher({
      readRuns: () => current,
      windowFocused: () => false,
      focusedSessionId: () => undefined,
      request: (intent) => {
        if (throwNext) {
          throwNext = false
          throw new Error('unavailable')
        }
        notifications.push(intent.kind)
      },
    })

    publisher.seed()
    current = [run('awaiting_input', 2)]
    expect(() =>
      publisher.onPublishedEvent('dev.harness.updated', { kind: 'run.status' })
    ).not.toThrow()
    current = [run('working', 3)]
    publisher.onPublishedEvent('dev.harness.updated', { kind: 'run.status' })
    current = [run('completed', 4)]
    publisher.onPublishedEvent('dev.harness.updated', { kind: 'run.status' })

    expect(notifications).toEqual(['completed'])
  })
})
