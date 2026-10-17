import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'

import { chatComposerDisabledReason } from '../src/chat/composer-availability'
import {
  CHAT_RESPONSE_UNAVAILABLE_REASON,
  chatTranscriptActionDisabledReason,
} from '../src/chat/transcript-availability'
import { MAX_BODY_TEXT, projectTranscriptEvents } from '../src/chat/presentation'

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
          text: 'Read /Users/example/private/project with token_sk-supersecret-value',
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
      event({
        eventId: 'credential-1',
        classification: 'credential',
        payload: { text: 'unclassified-secret-without-a-pattern' },
      }),
    ])

    // The unknown kind stays visible as an `other` row carrying only its wire
    // kind; its raw payload never becomes content. Credential events are the
    // one exclusion.
    expect(rows).toHaveLength(3)
    expect(rows[0]?.text).toContain('[private path]')
    expect(rows[0]?.text).toContain('[secret redacted]')
    expect(rows[0]?.text).not.toContain('supersecret')
    expect(rows[1]?.role).toBe('approval')
    expect(rows[2]).toMatchObject({ id: 'ignored-1', role: 'other', label: 'unknown.event' })
    expect(rows[2]?.text).toBeUndefined()
    // `event` is the canonical reference handed back to host callbacks; the
    // rendered fields are the ones that become markup.
    expect(JSON.stringify(rows.map(({ event: _event, ...shown }) => shown))).not.toContain(
      'do not render'
    )
    expect(rows.some((row) => row.id === 'credential-1')).toBe(false)
  })

  test('PEM redaction preserves the original unbounded delimiter semantics', () => {
    const privateMaterial = 'private-material-that-must-not-appear'
    const pem = [
      `-----BEGIN PRIVATE KEY${'-'.repeat(5_000)}\n`,
      privateMaterial,
      `\n-----END PRIVATE KEY${'-'.repeat(5_000)}`,
    ].join('')
    const row = projectTranscriptEvents([event({ payload: { text: pem } })])[0]

    expect(row?.body).toContain('[secret redacted]')
    expect(row?.body).not.toContain(privateMaterial)
  })

  test('unrendered known and future kinds expose only their wire name', () => {
    const rows = projectTranscriptEvents(
      ['file.observed', 'future.private_payload' as RuntimeEvent['kind']].map((kind, index) =>
        event({
          eventId: `unrendered-${index}`,
          kind,
          payload: {
            name: 'unclassified private answer',
            text: 'the user secret that does not match a token pattern',
            message: 'private conversation content',
          },
        })
      )
    )

    expect(rows).toHaveLength(2)
    for (const [index, row] of rows.entries()) {
      expect(row).toMatchObject({
        id: `unrendered-${index}`,
        role: 'other',
        kind: index === 0 ? 'file.observed' : 'future.private_payload',
        label: index === 0 ? 'file.observed' : 'future.private_payload',
      })
      expect(row.text).toBeUndefined()
      expect(row.body).toBeUndefined()
      expect(JSON.stringify(row)).not.toContain('unclassified private answer')
      expect(JSON.stringify(row)).not.toContain('user secret')
      expect(JSON.stringify(row)).not.toContain('private conversation content')
    }

    const fallback = projectTranscriptEvents(
      [
        event({
          eventId: 'unrendered-fallback',
          kind: 'file.observed',
          payload: { text: 'private fallback payload' },
        }),
      ],
      { projection: 'terminal_fallback' }
    )
    expect(JSON.stringify(fallback)).not.toContain('private fallback payload')
  })

  test('prose keeps line breaks and fragment whitespace; labels stay one line', () => {
    const rows = projectTranscriptEvents([
      event({ eventId: 'm', payload: { text: 'one\r\ntwo\n\n\tthree' } }),
      event({ eventId: 'd1', kind: 'turn.assistant_delta', payload: { text: 'Hel' } }),
      event({ eventId: 'd2', kind: 'turn.assistant_delta', payload: { text: 'lo ' } }),
      event({ eventId: 'd3', kind: 'turn.assistant_delta', payload: { text: 'world' } }),
    ])
    expect(rows[0]?.body).toBe('one\ntwo\n\n\tthree')
    expect(rows.slice(1).map((row) => row.body)).toEqual(['Hel', 'lo ', 'world'])
    expect(rows[0]?.text).not.toContain('\n')
  })

  test('a message body is bounded at the message limit and says so', () => {
    const rows = projectTranscriptEvents([
      event({ payload: { text: 'x'.repeat(MAX_BODY_TEXT + 10) } }),
      event({ eventId: 'short', payload: { text: 'ok' } }),
    ])
    expect(rows[0]?.body).toHaveLength(MAX_BODY_TEXT)
    expect(rows[0]?.bodyTruncated).toBe(true)
    expect(rows[1]?.bodyTruncated).toBeUndefined()
  })

  test('bounds rendered text to whole code points and strips control characters', () => {
    // The projector stops walking once it has `limit` surviving code points
    // rather than materializing the whole bounded window, so the truncation
    // boundary and the control-character filter are both pinned here: a
    // truncated multi-byte character must not become a replacement glyph, and
    // a label cut mid-string must still drop C0/DEL characters before it.
    const rows = projectTranscriptEvents([
      event({ kind: 'turn.assistant_delta', payload: { text: 'a\u0000b\u0007c\u001bd\u007fe' } }),
      event({
        eventId: 'label-1',
        kind: 'approval.requested',
        payload: { name: `deploy${'x'.repeat(400)}` },
      }),
      event({
        eventId: 'astral-1',
        kind: 'turn.assistant_delta',
        payload: { text: '😀'.repeat(4_096) },
      }),
    ])

    expect(rows[0]?.text).toBe('abcde')
    expect(rows[1]?.label.startsWith('deploy')).toBe(true)
    expect(rows[1]?.label).toHaveLength(160)
    // Astral characters count as one code point each, so 4096 survive the
    // text bound and no lone surrogate is emitted.
    expect(rows[2]?.text).toBe('😀'.repeat(4_096))
    expect([...(rows[2]?.text ?? '')]).toHaveLength(4_096)
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

describe('chat inline response availability', () => {
  test('fails closed when the host does not provide an authorized response handler', () => {
    expect(chatTranscriptActionDisabledReason('approval', undefined)).toContain(
      CHAT_RESPONSE_UNAVAILABLE_REASON
    )
    expect(chatTranscriptActionDisabledReason('question', undefined)).toContain(
      CHAT_RESPONSE_UNAVAILABLE_REASON
    )
  })

  test('allows an explicitly supplied host response handler', () => {
    expect(chatTranscriptActionDisabledReason('approval', () => undefined)).toBeUndefined()
    expect(chatTranscriptActionDisabledReason('question', async () => undefined)).toBeUndefined()
  })
})
