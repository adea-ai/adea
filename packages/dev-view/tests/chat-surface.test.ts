import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'

import { chatComposerDisabledReason } from '../src/chat/chat-composer'
import { projectTranscriptEvents } from '../src/chat/presentation'

function event(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    runtimeSessionId: 'session-1',
    generation: 1,
    seq: '1',
    occurredAt: '2026-09-22T10:00:00.000Z',
    receivedAt: '2026-09-22T10:00:00.000Z',
    source: 'host',
    sourceEventId: 'source-1',
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind: 'turn.assistant_message',
    payload: { text: 'hello' },
    ...overrides,
  }
}

const conversation = {
  archived: false,
  status: 'active',
} as Parameters<typeof chatComposerDisabledReason>[0]['conversation']

describe('chat surface presentation', () => {
  test('renders bounded known fields and redacts secrets and private paths', () => {
    const rows = projectTranscriptEvents([
      event({
        payload: {
          text: 'Read /Users/amf/private/project with token_sk-supersecret-value',
        },
      }),
      event({
        eventId: 'approval-1',
        kind: 'approval.requested',
        payload: { name: 'deploy' },
      }),
      event({
        eventId: 'ignored-1',
        kind: 'unknown.event' as RuntimeEvent['kind'],
        payload: { secret: 'do not render' },
      }),
    ])

    expect(rows).toHaveLength(2)
    expect(rows[0]?.text).toContain('[private path]')
    expect(rows[0]?.text).toContain('[secret redacted]')
    expect(rows[0]?.text).not.toContain('supersecret')
    expect(rows[1]?.role).toBe('approval')
  })

  test('adds an explicit terminal fallback projection label', () => {
    const rows = projectTranscriptEvents([], { projection: 'terminal_fallback' } as Pick<
      RuntimeSession,
      'projection'
    >)
    expect(rows[0]?.label).toBe('Terminal transcript projection')
    expect(rows[0]?.text).toContain('unavailable')
  })
})

describe('chat composer availability', () => {
  test('explains each authority and runtime gate', () => {
    expect(
      chatComposerDisabledReason({
        conversation,
        authority: 'dev',
        connected: true,
        awaitingApproval: false,
      })
    ).toContain('owned')
    expect(
      chatComposerDisabledReason({
        conversation,
        authority: 'chat',
        connected: true,
        awaitingApproval: true,
      })
    ).toContain('approval')
    expect(
      chatComposerDisabledReason({
        conversation,
        authority: 'chat',
        connected: false,
        awaitingApproval: false,
      })
    ).toContain('disconnected')
  })
})
