import { describe, expect, test } from 'bun:test'
import type { HarnessRun, RuntimeEvent, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'

import {
  exportTranscriptWindow,
  searchConversationHistory,
  virtualSearchRows,
} from '../src/chat/search'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const session: RuntimeSession = {
  id: 'session-1',
  scope: SCOPE,
  projectId: 'project-1',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  displayName: 'Adea task',
  lifecycle: 'active',
  archived: false,
  projection: 'structured',
  generation: 2,
  version: 3,
}

const run: HarnessRun = {
  id: 'run-2',
  scope: SCOPE,
  runtimeSessionId: session.id,
  installationId: 'installation-1',
  agentProfile: { id: 'profile-1', version: 1, displayName: 'Agent', capabilityPolicyVersion: 1 },
  state: 'completed',
  generation: 2,
  startedAt: '2026-09-22T10:00:00.000Z',
  finishedAt: '2026-09-22T10:01:00.000Z',
  version: 2,
}

function event(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    runtimeSessionId: session.id,
    generation: 2,
    seq: '1',
    occurredAt: '2026-09-22T10:00:10.000Z',
    receivedAt: '2026-09-22T10:00:10.000Z',
    source: 'host',
    sourceEventId: 'source-1',
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind: 'turn.user_input',
    payload: { text: 'deploy token_sk-secret-value from /Users/amf/private' },
    ...overrides,
  }
}

describe('searchConversationHistory', () => {
  test('searches canonical runs and event windows with jump targets and redaction', () => {
    const page = searchConversationHistory({
      sessions: [session],
      runs: [run],
      events: new Map([
        [
          session.id,
          [
            event({}),
            event({
              eventId: 'approval-1',
              sourceEventId: 'approval-source',
              seq: '2',
              kind: 'approval.requested',
              payload: { title: 'Deploy' },
            }),
          ],
        ],
      ]),
      query: 'deploy',
      limit: 10,
    })

    expect(page.totalMatches).toBe(2)
    expect(page.items.map((item) => item.kind)).toEqual(['prompt', 'approval'])
    const prompt = page.items.find((item) => item.kind === 'prompt')
    expect(prompt?.preview).toContain('[secret redacted]')
    expect(prompt?.preview).toContain('[private path]')
    expect(prompt?.jump).toMatchObject({ runtimeSessionId: session.id, eventId: 'event-1' })
  })

  test('paginates with an opaque bounded cursor and virtualizes a result window', () => {
    const page = searchConversationHistory({
      sessions: [session],
      runs: [run, { ...run, id: 'run-1', startedAt: '2026-09-22T09:00:00.000Z' }],
      events: new Map(),
      limit: 1,
    })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toMatch(/^v1\./)
    const next = searchConversationHistory({
      sessions: [session],
      runs: [run, { ...run, id: 'run-1', startedAt: '2026-09-22T09:00:00.000Z' }],
      events: new Map(),
      cursor: page.nextCursor,
      limit: 1,
    })
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id)
    expect(
      virtualSearchRows([...page.items, ...next.items], { start: 1, visible: 1, overscan: 0 })
    ).toHaveLength(1)
  })
})

describe('exportTranscriptWindow', () => {
  test('exports only the requested generation and bounded redacted fields', () => {
    const result = exportTranscriptWindow(
      [event({}), event({ eventId: 'other-generation', generation: 1, seq: '2' })],
      { runtimeSessionId: session.id, generation: 2 }
    )
    expect(result.exportedEvents).toBe(1)
    expect(result.truncated).toBe(false)
    expect(result.text).toContain('[secret redacted]')
    expect(result.text).not.toContain('supersecret')
  })
})
