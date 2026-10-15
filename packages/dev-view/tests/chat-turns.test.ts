import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { projectTranscriptEvents, type ChatTranscriptItem } from '../src/chat/presentation'
import { buildChatTurns, CHAT_ASSISTANT_TEXT_LIMIT } from '../src/chat/model/turns'

let sequence = 0
function event(
  kind: RuntimeEvent['kind'],
  payload: unknown,
  id?: string,
  run: string | null = 'run-1'
) {
  sequence += 1
  return {
    schemaVersion: 1,
    eventId: id ?? `e${sequence}`,
    runtimeSessionId: 'session-1',
    ...(typeof run === 'string' ? { harnessRunId: run } : {}),
    generation: 1,
    seq: String(sequence),
    occurredAt: '2026-10-14T10:00:00.000Z',
    receivedAt: '2026-10-14T10:00:00.000Z',
    source: 'host',
    sourceEventId: `s${sequence}`,
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind,
    payload,
  } satisfies RuntimeEvent
}

const turns = (events: readonly RuntimeEvent[]) => buildChatTurns(projectTranscriptEvents(events))

describe('buildChatTurns', () => {
  test('a user prompt opens a turn and everything after it nests inside', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'fix the build' }, 'u1'),
      event('tool.started', { name: 'bash' }, 't1'),
      event('turn.assistant_message', { text: 'Done.' }, 'a1'),
      event('turn.user_input', { text: 'thanks' }, 'u2'),
    ])
    expect(built.map((turn) => turn.id)).toEqual(['u1', 'u2'])
    expect(built[0]?.entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      'activity:t1',
      'text:a1',
    ])
    expect(built[1]?.entries).toHaveLength(0)
  })

  test('events before any prompt form a lead turn without a user message', () => {
    const { turns: built } = turns([
      event('session.ready', {}, 's1'),
      event('turn.user_input', { text: 'hi' }, 'u1'),
    ])
    expect(built[0]).toMatchObject({ id: 'lead' })
    expect(built[0]?.user).toBeUndefined()
    expect(built[0]?.entries.map((entry) => entry.type)).toEqual(['notice'])
  })

  test('consecutive deltas of one run join into one block with their whitespace intact', () => {
    const { turns: built, entryByEventId } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('turn.assistant_delta', { text: 'Hel' }, 'd1'),
      event('turn.assistant_delta', { text: 'lo ' }, 'd2'),
      event('turn.assistant_delta', { text: 'world' }, 'd3'),
    ])
    const [entry] = built[0]?.entries ?? []
    expect(entry).toMatchObject({ type: 'text', id: 'd1', text: 'Hello world', source: 'delta' })
    expect(entryByEventId.get('d3')).toBe('d1')
  })

  test('deltas without a harness run identity do not merge under a guess', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('turn.assistant_delta', { text: 'one' }, 'd1', null),
      event('turn.assistant_delta', { text: 'two' }, 'd2', null),
    ])

    expect(built[0]?.entries.map((entry) => entry.id)).toEqual(['d1', 'd2'])
    expect(built[0]?.entries.map((entry) => entry.type === 'text' && entry.text)).toEqual([
      'one',
      'two',
    ])
  })

  test('a tool, an approval or another run ends the block; nothing is reordered', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('turn.assistant_delta', { text: 'before ' }, 'd1'),
      event('tool.started', { name: 'bash' }, 't1'),
      event('turn.assistant_delta', { text: 'after ' }, 'd2'),
      event('turn.assistant_delta', { text: 'other run' }, 'd3', 'run-2'),
    ])
    expect(built[0]?.entries.map((entry) => entry.id)).toEqual(['d1', 't1', 'd2', 'd3'])
  })

  test('lifecycle is never inferred by pairing started and completed events', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('tool.started', { name: 'bash', id: 'call-1' }, 't1'),
      event('tool.completed', { name: 'bash', id: 'call-1' }, 't2'),
    ])
    expect(built[0]?.entries).toHaveLength(2)
    expect(built[0]?.entries.every((entry) => entry.type === 'activity')).toBe(true)
  })

  test('unknown kinds, terminal and usage events stay visible, in position', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('file.observed', { path: '/Users/me/secret.txt' }, 'f1'),
      event('usage.observed', { tokens: 3 }, 'x1'),
      event('terminal.cwd_changed', {}, 'c1'),
      event('wat.is.this' as RuntimeEvent['kind'], { a: 1 }, 'z1'),
    ])
    expect(built[0]?.entries.map((entry) => entry.id)).toEqual(['f1', 'x1', 'c1', 'z1'])
    const shown = built[0]?.entries.map((entry) =>
      entry.type === 'activity' ? { label: entry.item.label, text: entry.item.text } : entry
    )
    expect(JSON.stringify(shown)).not.toContain('/Users/me/secret.txt')
  })

  test('credential-classified events never reach a turn', () => {
    const credential = { ...event('turn.assistant_message', { text: 'sk-abcdefghijkl' }, 'k1') }
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      { ...credential, classification: 'credential' },
    ])
    expect(built[0]?.entries).toHaveLength(0)
  })

  test('an explicit error flag on turn.result marks the block failed, nothing else does', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('turn.result', { text: 'It broke.', isError: true }, 'r1'),
      event('turn.result', { text: 'status: failed in prose' }, 'r2'),
    ])
    const [first, second] = built[0]?.entries ?? []
    expect(first).toMatchObject({ type: 'text', source: 'result', failed: true })
    expect(second).toMatchObject({ type: 'text', source: 'result', failed: false })
  })

  test('long streamed prose is cut at the limit and flagged', () => {
    const chunk = 'x'.repeat(20_000)
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('turn.assistant_delta', { text: chunk }, 'd1'),
      event('turn.assistant_delta', { text: chunk }, 'd2'),
    ])
    const [entry] = built[0]?.entries ?? []
    expect(entry?.type === 'text' && entry.text.length).toBe(CHAT_ASSISTANT_TEXT_LIMIT)
    expect(entry?.type === 'text' && entry.truncated).toBe(true)
  })

  test('approvals and questions keep their own entries and event ids', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('approval.requested', { name: 'deploy' }, 'p1'),
      event('question.requested', { question: 'Which env?' }, 'q1'),
    ])
    expect(built[0]?.entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      'approval:p1',
      'question:q1',
    ])
  })
})

describe('question wording', () => {
  test("a question's own wording outranks its name, so the person sees what to answer", () => {
    const [row] = projectTranscriptEvents([
      event('question.requested', { name: 'Target', question: 'Which environment?' }, 'q1'),
    ])
    expect(row?.label).toBe('Which environment?')
  })

  test('a tool keeps its name as the label', () => {
    const [row] = projectTranscriptEvents([
      event('tool.started', { name: 'bash', question: 'ignored for tools' }, 't1'),
    ])
    expect(row?.label).toBe('bash')
  })
})

const proseOf = (events: readonly RuntimeEvent[]) => {
  const { turns: built } = turns(events)
  const entries = built.flatMap((turn) => turn.entries)
  return {
    entries,
    texts: entries.flatMap((entry) => (entry.type === 'text' ? [entry.text] : [])),
  }
}

describe('whitespace-only streamed fragments', () => {
  test('secrets split across assistant deltas are redacted after the fragments join', () => {
    const fragments = ['The response contains sk-', 'supersecretvalue1234 and must be hidden.']
    const { texts } = proseOf([
      event('turn.user_input', { text: 'hi' }, 'u1'),
      ...fragments.map((text, index) => event('turn.assistant_delta', { text }, `d${index}`)),
    ])

    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('[secret redacted]')
    expect(texts[0]).not.toContain('supersecretvalue1234')
  })

  test('split secrets are redacted even when missing run identity keeps entries separate', () => {
    const fragments = ['The response contains sk-', 'supersecretvalue1234 and must be hidden.']
    const { turns: built } = turns([
      event('turn.user_input', { text: 'hi' }, 'u1'),
      ...fragments.map((text, index) => event('turn.assistant_delta', { text }, `d${index}`, null)),
    ])
    const entries = built[0]?.entries ?? []
    const texts = entries.flatMap((entry) => (entry.type === 'text' ? [entry.text] : []))

    expect(entries.map((entry) => entry.id)).toEqual(['d0', 'd1'])
    expect(texts.join('')).toContain('[secret redacted]')
    expect(texts.join('')).not.toContain('supersecretvalue1234')
    expect(texts).toEqual(['The response contains [secret redacted]', ' and must be hidden.'])
  })

  test('a long run does not consume the scan window for later deltas with another known run', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'hi' }, 'u1'),
      event('turn.assistant_delta', { text: 'x'.repeat(66_000) }, 'long', 'long-run'),
      event(
        'turn.assistant_delta',
        { text: 'The response contains sk-' },
        'secret-1',
        'secret-run'
      ),
      event(
        'turn.assistant_delta',
        { text: 'supersecretvalue1234 and must be hidden.' },
        'secret-2',
        'secret-run'
      ),
    ])
    const entries = built.flatMap((turn) => turn.entries)
    const texts = entries.flatMap((entry) => (entry.type === 'text' ? [entry.text] : []))

    expect(entries[0]).toMatchObject({ type: 'text', truncated: true })
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('[secret redacted]')
    expect(JSON.stringify(entries)).not.toContain('supersecretvalue1234')
  })

  test('a long run does not consume the scan window for later deltas without run IDs', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'hi' }, 'u1'),
      event('turn.assistant_delta', { text: 'x'.repeat(66_000) }, 'long', null),
      event('turn.assistant_delta', { text: 'The response contains sk-' }, 'secret-1', null),
      event(
        'turn.assistant_delta',
        { text: 'supersecretvalue1234 and must be hidden.' },
        'secret-2',
        null
      ),
    ])
    const entries = built.flatMap((turn) => turn.entries)
    const texts = entries.flatMap((entry) => (entry.type === 'text' ? [entry.text] : []))

    expect(entries[0]).toMatchObject({ type: 'text', truncated: true })
    expect(entries.map((entry) => entry.id)).toEqual(['long', 'secret-1', 'secret-2'])
    expect(texts.join('')).toContain('[secret redacted]')
    expect(JSON.stringify(entries)).not.toContain('supersecretvalue1234')
  })

  test('Bearer tokens stay redacted when unbounded whitespace exceeds the cross-delta context', () => {
    const separators = [
      ' '.repeat(4_996), // leaves only a suffix of "Bearer" in the 5,000-unit context
      ' '.repeat(6_000),
      '\n'.repeat(6_000),
      '\t'.repeat(6_000),
      '\r\n'.repeat(3_000) + '\r', // raw overlap fills the limit before CRLF normalization
    ]
    const credentialParts = [['secretAccessToken987654'], ['secretAccess', 'Token987654']]

    for (const [separatorIndex, separator] of separators.entries()) {
      for (const [partsIndex, parts] of credentialParts.entries()) {
        const { turns: built } = turns([
          event('turn.user_input', { text: 'hi' }, `u${separatorIndex}-${partsIndex}`),
          event(
            'turn.assistant_delta',
            { text: 'Bearer' },
            `bearer-${separatorIndex}-${partsIndex}`,
            null
          ),
          event(
            'turn.assistant_delta',
            { text: separator },
            `spaces-${separatorIndex}-${partsIndex}`,
            null
          ),
          ...parts.map((text, partIndex) =>
            event(
              'turn.assistant_delta',
              { text },
              `credential-${separatorIndex}-${partsIndex}-${partIndex}`,
              null
            )
          ),
        ])
        const entries = built.flatMap((turn) => turn.entries)
        const serialized = JSON.stringify(entries)

        for (const part of parts) expect(serialized).not.toContain(part)
        expect(entries.at(-1)).toMatchObject({ type: 'text', truncated: true })
      }
    }
  })

  test('a CRLF split across deltas stays protected after raw overlap is bounded', () => {
    const privateToken = 'splitBoundaryToken12345'
    const { turns: built } = turns([
      event('turn.user_input', { text: 'hi' }, 'u-crlf'),
      event('turn.assistant_delta', { text: 'Bearer\r' }, 'bearer-crlf', null),
      event('turn.assistant_delta', { text: '\n' + '\r\n'.repeat(3_000) }, 'spaces-crlf', null),
      event('turn.assistant_delta', { text: privateToken }, 'token-crlf', null),
    ])
    const entries = built.flatMap((turn) => turn.entries)

    expect(JSON.stringify(entries)).not.toContain(privateToken)
    expect(entries.at(-1)).toMatchObject({ type: 'text', truncated: true })
  })

  test('PEM bodies remain redacted with delimiter runs longer than the old bound', () => {
    const privateMaterial = 'private-material-that-must-not-appear'
    const fragments = [
      '-----BEGIN PRIVATE KEY',
      `${'-'.repeat(5_000)}\n${privateMaterial}\n`,
      `-----END PRIVATE KEY${'-'.repeat(5_000)}`,
    ]
    const { turns: built } = turns([
      event('turn.user_input', { text: 'hi' }, 'u1'),
      ...fragments.map((text, index) =>
        event('turn.assistant_delta', { text }, `pem-${index}`, null)
      ),
    ])
    const entries = built.flatMap((turn) => turn.entries)

    expect(JSON.stringify(entries)).not.toContain(privateMaterial)
    expect(entries.some((entry) => entry.type === 'text' && entry.truncated)).toBe(true)
  })

  test('a sanitized omitted body never falls back to an unsanitized activity detail', () => {
    const item = {
      id: 'd1',
      role: 'assistant',
      kind: 'turn.assistant_delta',
      label: 'Assistant',
      text: 'raw detail must not be restored',
    } satisfies ChatTranscriptItem
    const { turns: built } = buildChatTurns([item])

    expect(JSON.stringify(built)).not.toContain('raw detail must not be restored')
    expect(built[0]?.entries[0]).toMatchObject({ type: 'activity', id: 'd1' })
  })

  test('an omitted delta body retains its truncation marker', () => {
    const item = {
      id: 'd1',
      role: 'assistant',
      kind: 'turn.assistant_delta',
      label: 'Assistant',
      text: 'unavailable content',
      bodyTruncated: true,
    } satisfies ChatTranscriptItem
    const { turns: built } = buildChatTurns([item])

    expect(built[0]?.entries[0]).toMatchObject({
      type: 'text',
      id: 'd1',
      text: '',
      truncated: true,
    })
    expect(JSON.stringify(built)).not.toContain('unavailable content')
  })

  test('an empty preferred payload field falls through to the next text field', () => {
    const { texts } = proseOf([
      event('turn.user_input', { text: 'hi' }, 'u1'),
      event('turn.assistant_delta', { text: '', content: 'still visible' }, 'd1'),
    ])

    expect(texts).toEqual(['still visible'])
  })

  test('a lone space between words stays in one block of prose', () => {
    const { entries, texts } = proseOf([
      event('turn.user_input', { text: 'hi' }, 'u1'),
      event('turn.assistant_delta', { text: 'Hello' }, 'd1'),
      event('turn.assistant_delta', { text: ' ' }, 'd2'),
      event('turn.assistant_delta', { text: 'world' }, 'd3'),
    ])
    expect(texts).toEqual(['Hello world'])
    expect(entries).toHaveLength(1)
  })

  test('newline and tab fragments are kept, including between paragraphs', () => {
    const { entries, texts } = proseOf([
      event('turn.user_input', { text: 'hi' }, 'u1'),
      event('turn.assistant_delta', { text: 'One' }, 'd1'),
      event('turn.assistant_delta', { text: '\n\n' }, 'd2'),
      event('turn.assistant_delta', { text: '\t' }, 'd3'),
      event('turn.assistant_delta', { text: 'Two' }, 'd4'),
    ])
    expect(texts).toEqual(['One\n\n\tTwo'])
    expect(entries).toHaveLength(1)
  })

  test('a fence streamed with whitespace-only fragments keeps its source exact', () => {
    const fragments = ['Here:\n\n```js\nif (a) {', '\n', '\t', 'return  b;', '   ', '\n', '}\n```']
    const { entries, texts } = proseOf([
      event('turn.user_input', { text: 'show' }, 'u1'),
      ...fragments.map((text, index) => event('turn.assistant_delta', { text }, `d${index}`)),
    ])
    expect(entries).toHaveLength(1)
    expect(texts).toEqual([fragments.join('')])
  })

  test('CRLF fragments normalise to a line feed and stay joined', () => {
    const { texts } = proseOf([
      event('turn.user_input', { text: 'hi' }, 'u1'),
      event('turn.assistant_delta', { text: 'a' }, 'd1'),
      event('turn.assistant_delta', { text: '\r\n' }, 'd2'),
      event('turn.assistant_delta', { text: 'b' }, 'd3'),
    ])
    expect(texts).toEqual(['a\nb'])
  })

  test('an empty fragment is still a visible event, not prose', () => {
    const { entries, texts } = proseOf([
      event('turn.user_input', { text: 'hi' }, 'u1'),
      event('turn.assistant_delta', { text: 'a' }, 'd1'),
      event('turn.assistant_delta', { text: '' }, 'd2'),
      event('turn.assistant_delta', { text: 'b' }, 'd3'),
    ])
    expect(texts).toEqual(['a', 'b'])
    expect(entries.map((entry) => entry.type)).toEqual(['text', 'activity', 'text'])
  })

  test('whitespace-only fragments are still bounded and redacted around', () => {
    const { texts } = proseOf([
      event('turn.user_input', { text: 'hi' }, 'u1'),
      event('turn.assistant_delta', { text: 'key sk-supersecretvalue1234' }, 'd1'),
      event('turn.assistant_delta', { text: ' '.repeat(50_000) }, 'd2'),
    ])
    expect(texts[0]).toContain('[secret redacted]')
    expect(texts[0]).not.toContain('supersecretvalue')
    expect(texts[0]?.length).toBeLessThanOrEqual(CHAT_ASSISTANT_TEXT_LIMIT)
  })
})
