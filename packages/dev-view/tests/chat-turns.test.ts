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

const proseForFragments = (fragments: readonly string[]) =>
  proseOf([
    event('turn.user_input', { text: 'hi' }, 'u1'),
    ...fragments.map((text, index) => event('turn.assistant_delta', { text }, `d${index}`)),
  ])

const deltaAt = (text: string, id: string, run: string | null, generation = 1) => ({
  ...event('turn.assistant_delta', text === '' ? { text: '' } : { text }, id, run),
  generation,
})

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

  test('a CRLF split across fragments lays out like the unsplit text', () => {
    const splits: readonly (readonly string[])[] = [
      ['a\r\nb'],
      ['a', '\r\nb'],
      ['a\r', '\nb'],
      ['a\r\n', 'b'],
      ['a', '\r', '\nb'],
      ['a\r', '\n', 'b'],
      ['a', '\r', '\n', 'b'],
      ['a\r', 'b'],
      ['a\r\n\r', '\nb'],
    ]
    for (const fragments of splits) {
      const joined = fragments.join('')
      const { entries, texts } = proseForFragments(fragments)
      expect({ fragments, texts }).toEqual({ fragments, texts: [joined.replace(/\r\n?/g, '\n')] })
      expect(entries).toHaveLength(1)
    }
    // A CR that ends the stream is still a line break.
    expect(proseForFragments(['a', '\r']).texts).toEqual(['a\n'])
  })

  test('a CR and an LF in different prose runs each keep their own line feed', () => {
    const cases = {
      'different run ids': [deltaAt('a\r', 'd0', 'run-1'), deltaAt('\nb', 'd1', 'run-2')],
      'changed generation': [deltaAt('a\r', 'd0', 'run-1', 1), deltaAt('\nb', 'd1', 'run-1', 2)],
      'missing run id on the LF side': [deltaAt('a\r', 'd0', 'run-1'), deltaAt('\nb', 'd1', null)],
      'missing run id on the CR side': [deltaAt('a\r', 'd0', null), deltaAt('\nb', 'd1', 'run-1')],
      'no run ids at all': [deltaAt('a\r', 'd0', null), deltaAt('\nb', 'd1', null)],
    }
    for (const [name, deltas] of Object.entries(cases)) {
      const { entries, texts } = proseOf([
        event('turn.user_input', { text: 'hi' }, 'u1'),
        ...deltas,
      ])
      expect({ name, texts }).toEqual({ name, texts: ['a\n', '\nb'] })
      expect({ name, blocks: entries.length }).toEqual({ name, blocks: 2 })
    }
  })

  test('a CRLF is not rejoined across a fragment that is not part of the prose run', () => {
    // The empty fragment is its own visible event, so the two halves are not one block.
    const { texts } = proseForFragments(['a\r', '', '\nb'])
    expect(texts).toEqual(['a\n', '\nb'])
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

// ─── Source-reported summaries and cited responses (#1388, #1389) ───────────

function wire(
  kind: RuntimeEvent['kind'],
  payload: unknown,
  id: string,
  over: Partial<RuntimeEvent> = {}
): RuntimeEvent {
  return {
    ...event(
      kind,
      kind === 'turn.assistant_message' && payload !== null && typeof payload === 'object'
        ? { messageId: `message-${id}`, supersedes: 'deltas', ...payload }
        : payload,
      id
    ),
    source: 'native',
    classification: 'workspace_private',
    ...over,
  }
}

const snapshot = {
  schemaVersion: 1,
  provenance: 'source_reported',
  visibility: 'user_visible',
  format: 'snapshot',
} as const

const think = (
  id: string,
  revision: number,
  text: string,
  status: 'streaming' | 'completed' | 'failed' | 'cancelled' | 'unknown' = 'streaming',
  over: Partial<RuntimeEvent> = {},
  summaryId = 'think-1',
  durationMs?: number
) =>
  wire(
    'turn.reasoning_summary',
    {
      ...snapshot,
      revision,
      summaryId,
      text,
      status,
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
    id,
    over
  )

const step = (
  id: string,
  revision: number,
  stepId: string,
  position: number,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown',
  text = '',
  methodId = 'method-1'
) =>
  wire(
    'turn.method_step_summary',
    { ...snapshot, revision, methodId, stepId, position, title: `Step ${stepId}`, text, status },
    id
  )

const references = (citations: readonly { sourceId: string; start: number; end: number }[]) => ({
  schemaVersion: 1,
  sources: [{ id: 'book', title: 'The Book', url: 'https://doc.rust-lang.org/book/' }],
  citations,
})
const message = (payload: unknown, id = 'a1') => wire('turn.assistant_message', payload, id)
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const shown = (events: readonly RuntimeEvent[]) => projectTranscriptEvents(events)[0]!
const many = (sources: number, citations: number) => ({
  text: 'abcdefghij'.repeat(20),
  references: {
    schemaVersion: 1,
    sources: Array.from({ length: sources }, (_, index) => ({
      id: `s${index}`,
      title: `Source ${index}`,
      url: `https://example.com/${index}`,
    })),
    citations: Array.from({ length: citations }, (_, index) => ({
      sourceId: `s${index % Math.max(sources, 1)}`,
      start: index,
      end: index + 1 + (index % 7),
    })),
  },
})

describe('reasoning and method summaries', () => {
  test('a snapshot becomes one stable entry that later revisions replace in place', () => {
    const { turns: built, entryByEventId } = turns([
      event('turn.user_input', { text: 'go' }, 'u1'),
      think('r1', 1, 'First thought'),
      event('tool.started', { name: 'bash' }, 't1'),
      think('r2', 2, 'First thought, then more'),
      think('r3', 3, 'First thought, then more, done', 'completed', {}, 'think-1', 4200),
    ])
    const entries = built[0]!.entries
    expect(entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      'reasoning:r1',
      'activity:t1',
    ])
    const reasoning = entries[0] as Extract<(typeof entries)[number], { type: 'reasoning' }>
    expect(reasoning.summary).toMatchObject({ revision: 3, status: 'completed', durationMs: 4200 })
    expect(reasoning.summary.text).toBe('First thought, then more, done')
    expect(reasoning.eventIds).toEqual(['r1', 'r2', 'r3'])
    // Every snapshot event finds the entry that shows it.
    expect(['r1', 'r2', 'r3'].map((id) => entryByEventId.get(id))).toEqual(['r1', 'r1', 'r1'])
  })

  test('an older, repeated or post-terminal snapshot never changes what is shown', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'go' }, 'u1'),
      think('r1', 2, 'Second'),
      think('r2', 1, 'Stale first'),
      think('r3', 2, 'Same revision again'),
      think('r4', 3, 'Done', 'completed'),
      think('r5', 4, 'Revived after completion'),
    ])
    const [reasoning] = built[0]!.entries as readonly {
      type: 'reasoning'
      summary: { text: string; revision: number; status: string }
      eventIds: readonly string[]
    }[]
    expect(reasoning!.summary).toMatchObject({ text: 'Done', revision: 3, status: 'completed' })
    expect(reasoning!.eventIds).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
  })

  test('ids reused by another run, generation or source are separate summaries', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'go' }, 'u1'),
      think('a', 1, 'run one'),
      think('b', 1, 'run two', 'streaming', { harnessRunId: 'run-2' }),
      think('c', 1, 'generation two', 'streaming', { generation: 2 }),
      think('d', 1, 'other id', 'streaming', {}, 'think-2'),
    ])
    expect(built[0]!.entries.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('method steps group by method, order by position, and keep the first position', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'go' }, 'u1'),
      step('s1', 1, 'compare', 1, 'pending'),
      step('s2', 1, 'search', 0, 'running'),
      event('tool.started', { name: 'bash' }, 't1'),
      step('s3', 2, 'search', 5, 'completed', 'found it'),
      step('s4', 1, 'other', 0, 'running', '', 'method-2'),
    ])
    const entries = built[0]!.entries
    expect(entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      'method:s1',
      'activity:t1',
      'method:s4',
    ])
    const method = entries[0] as Extract<(typeof entries)[number], { type: 'method' }>
    expect(method.steps.map((item) => [item.stepId, item.position, item.summary.status])).toEqual([
      ['search', 0, 'completed'],
      ['compare', 1, 'pending'],
    ])
    expect(method.eventIds).toEqual(['s1', 's2', 's3'])
  })

  test('a payload that does not satisfy the wire contract stays an unknown line', () => {
    const wrongSource = think('x1', 1, 'forged', 'streaming', { source: 'host' })
    const hint = think('x2', 1, 'hint', 'streaming', { confidence: 'untrusted_hint' })
    const extraKey = wire(
      'turn.reasoning_summary',
      { ...snapshot, revision: 1, summaryId: 's', text: 't', status: 'streaming', hidden: 'cot' },
      'x3'
    )
    const noRun = think('x4', 1, 'no run', 'streaming', { harnessRunId: undefined })
    const rows = projectTranscriptEvents([wrongSource, hint, extraKey, noRun])
    expect(rows.map((row) => row.role)).toEqual(['other', 'other', 'other', 'other'])
    expect(rows.every((row) => row.summary === undefined && row.text === undefined)).toBe(true)
  })

  test('summary text is redacted and bounded like every other rendered string', () => {
    const [row] = projectTranscriptEvents([
      think('r1', 1, 'Key sk-supersecretvalue1234 in /Users/example/private'),
    ])
    expect(row!.summary?.text).toBe('Key [secret redacted] in [private path]')
  })
})

describe('the display limit cuts on a whole code point', () => {
  const lead = 'a'.repeat(CHAT_ASSISTANT_TEXT_LIMIT - 1)

  test('a final message ending in an emoji at the limit never shows half of it', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'go' }, 'u1'),
      wire('turn.assistant_message', { text: `${lead}\u{1F600}` }, 'a1'),
    ])
    const entry = built[0]!.entries[0]!
    expect(entry.type === 'text' && entry.text.isWellFormed()).toBe(true)
    expect(entry).toMatchObject({ type: 'text', text: lead, truncated: true })
  })

  test('a streamed run whose fragments cross the limit never shows half of a character', () => {
    const { texts } = proseOf([
      event('turn.user_input', { text: 'go' }, 'u1'),
      event('turn.assistant_delta', { text: lead }, 'd1'),
      event('turn.assistant_delta', { text: '\u{1F600}' }, 'd2'),
    ])
    expect(texts).toHaveLength(1)
    expect(texts[0]!.isWellFormed()).toBe(true)
    expect(texts[0]).toBe(lead)
  })

  test('a whole character that fits under the limit is kept', () => {
    const fits = 'a'.repeat(CHAT_ASSISTANT_TEXT_LIMIT - 2)
    const { texts } = proseOf([
      event('turn.user_input', { text: 'go' }, 'u1'),
      event('turn.assistant_delta', { text: fits }, 'd1'),
      event('turn.assistant_delta', { text: '\u{1F600}' }, 'd2'),
    ])
    expect(texts[0]).toBe(`${fits}\u{1F600}`)
  })

  test('a citation that reaches past the cut is dropped from the coordinates but stays counted', () => {
    const text = `${lead}\u{1F600}`
    const { turns: built } = turns([
      event('turn.user_input', { text: 'go' }, 'u1'),
      wire(
        'turn.assistant_message',
        {
          text,
          references: references([
            { sourceId: 'book', start: 0, end: 4 },
            { sourceId: 'book', start: lead.length, end: text.length },
          ]),
        },
        'a1'
      ),
    ])
    const entry = built[0]!.entries[0]!
    expect(entry.type).toBe('text')
    if (entry.type !== 'text') return
    expect(entry.text).toBe(lead)
    expect(entry.references?.cited).toBe(2)
    expect(entry.references?.citations).toEqual([{ sourceId: 'book', start: 0, end: 4 }])
  })
})

describe('cited responses', () => {
  const text = 'Rust needs no GC. It is fast.'

  test('source titles, snippets and links pass through the display redaction', () => {
    const secret = 'sk-supersecretvalue1234'
    const [row] = projectTranscriptEvents([
      message({
        text,
        references: {
          schemaVersion: 1,
          sources: [
            {
              id: 'a',
              title: `Guide ${secret} for /Users/example/private`,
              url: 'https://example.com/guide',
              snippet: `Bearer abcdefghijklmnop1234 and /home/example/notes`,
            },
          ],
          citations: [{ sourceId: 'a', start: 0, end: 4 }],
        },
      }),
    ])
    const [source] = row!.references!.sources
    expect(source!.title).toBe('Guide [secret redacted] for [private path]')
    expect(source!.snippet).toBe('Bearer [secret redacted] and [private path]')
    expect(source!.url).toBe('https://example.com/guide')
    expect(JSON.stringify(row!.references)).not.toMatch(
      /supersecret|abcdefghijklmnop|example\/private/
    )
  })

  test('a link the redaction would change is dropped, never rewritten or shown', () => {
    const rows = projectTranscriptEvents([
      message(
        {
          text,
          references: {
            schemaVersion: 1,
            sources: [
              { id: 'tok', title: 'Token link', url: 'https://example.com/cb?token_abcdefgh12345' },
              {
                id: 'key',
                title: 'Key link',
                url: 'https://example.com/a/sk-supersecretvalue1234',
              },
              { id: 'path', title: 'Path link', url: 'https://example.com/home/someone/notes' },
              { id: 'ok', title: 'Plain', url: 'https://example.com/docs/ownership' },
            ],
            citations: [{ sourceId: 'ok', start: 0, end: 4 }],
          },
        },
        'links'
      ),
    ])
    const sources = rows[0]!.references!.sources
    expect(sources.map((source) => source.url)).toEqual([
      undefined,
      undefined,
      undefined,
      'https://example.com/docs/ownership',
    ])
    expect(sources.map((source) => source.title)).toEqual([
      'Token link',
      'Key link',
      'Path link',
      'Plain',
    ])
    expect(JSON.stringify(rows[0]!.references)).not.toMatch(/token_abcdefgh|supersecret/)
  })

  test('a title that redaction or trimming empties still names its source', () => {
    const [row] = projectTranscriptEvents([
      message({
        text,
        references: {
          schemaVersion: 1,
          sources: [{ id: 'a', title: '\u0007\u0007', url: 'https://example.com/x' }],
          citations: [{ sourceId: 'a', start: 0, end: 4 }],
        },
      }),
    ])
    expect(row!.references!.sources[0]!.title).toBe('Source 1')
  })
  test('spans map onto the displayed body, shifted past trimmed leading whitespace', () => {
    const padded = `\n  ${text}\n`
    const start = padded.indexOf('Rust')
    const [row] = projectTranscriptEvents([
      message({
        text: padded,
        references: references([{ sourceId: 'book', start, end: start + 17 }]),
      }),
    ])
    expect(row!.body).toBe(text)
    expect(row!.references).toMatchObject({
      inline: 'mapped',
      cited: 1,
      citations: [{ sourceId: 'book', start: 0, end: 17 }],
    })
  })

  test('a body that redaction changed keeps the sources and drops every span', () => {
    const secret = 'Use sk-supersecretvalue1234 here.'
    const [row] = projectTranscriptEvents([
      message({ text: secret, references: references([{ sourceId: 'book', start: 0, end: 3 }]) }),
    ])
    expect(row!.body).toBe('Use [secret redacted] here.')
    expect(row!.references).toMatchObject({ inline: 'text-changed', citations: [], cited: 1 })
    expect(row!.references?.sources).toHaveLength(1)
  })

  test('references that fail validation are not drawn at all', () => {
    const bad = {
      ...references([{ sourceId: 'book', start: 0, end: 4 }]),
      sources: [{ id: 'book', title: 'Local', url: 'http://localhost/secret' }],
    }
    const rows = projectTranscriptEvents([
      message({ text, references: bad }, 'bad-url'),
      message(
        { text, references: references([{ sourceId: 'missing', start: 0, end: 4 }]) },
        'bad-id'
      ),
      message(
        { text, references: references([{ sourceId: 'book', start: 0, end: 999 }]) },
        'bad-range'
      ),
      wire('turn.assistant_message', { text, references: references([]) }, 'terminal', {
        source: 'terminal_fallback',
        confidence: 'bounded_projection',
      }),
    ])
    expect(rows.map((row) => row.references)).toEqual([undefined, undefined, undefined, undefined])
    expect(rows.every((row) => row.body === text)).toBe(true)
  })

  test('a message without references carries none, and the turn entry passes them through', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      message({ text, references: references([{ sourceId: 'book', start: 0, end: 17 }]) }, 'a1'),
      wire('turn.assistant_message', { text: 'plain' }, 'a2'),
    ])
    const [cited, plain] = built[0]!.entries as readonly { references?: unknown }[]
    expect(cited!.references).toMatchObject({ cited: 1 })
    expect(plain!.references).toBeUndefined()
  })
})

describe('exact limits of summaries and cited responses', () => {
  test('summary text of exactly 4,096 characters is drawn whole; one more is not a summary', () => {
    expect(shown([think('a', 1, 'x'.repeat(4096))]).summary?.text).toHaveLength(4096)
    const over = shown([think('b', 1, 'x'.repeat(4097))])
    expect(over.role).toBe('other')
    expect(over.summary).toBeUndefined()
  })

  test('astral characters count as two UTF-16 units against the 4,096-unit summary bound', () => {
    // 2,048 four-byte characters are exactly 4,096 units; one more is over.
    const at = wire(
      'turn.reasoning_summary',
      {
        ...snapshot,
        revision: 1,
        summaryId: 'think-1',
        text: '😀'.repeat(2048),
        status: 'streaming',
      },
      'at'
    )
    const over = wire(
      'turn.reasoning_summary',
      {
        ...snapshot,
        revision: 1,
        summaryId: 'think-2',
        text: '😀'.repeat(2049),
        status: 'streaming',
      },
      'over'
    )
    expect(shown([at]).role).toBe('reasoning')
    expect(shown([over]).role).toBe('other')
  })

  test('an unpaired surrogate makes a summary unknown rather than drawing a repaired string', () => {
    expect(shown([think('s', 1, `bad ${String.fromCharCode(0xd83d)}`)]).role).toBe('other')
  })

  describe('cited response size and the display limit', () => {
    const source = { id: 'book', title: 'The Book', url: 'https://doc.rust-lang.org/book/' }
    const reply = (length: number, endAt: number) => ({
      text: 'a'.repeat(length),
      references: {
        schemaVersion: 1,
        sources: [source],
        citations: [{ sourceId: 'book', start: 0, end: endAt }],
      },
    })

    test('the 48 KiB bound on text plus references is exact', () => {
      let length = 40_000
      while (bytes(reply(length + 1, 1)) <= 48 * 1024) length += 1
      const at = wire('turn.assistant_message', reply(length, 1), 'at')
      const over = wire('turn.assistant_message', reply(length + 1, 1), 'over')
      expect(shown([at]).references?.sources).toHaveLength(1)
      expect(shown([over]).references).toBeUndefined()
      // Either way the prose is drawn; only the claim of sources depends on the bound.
      expect(shown([over]).body?.length).toBeGreaterThan(0)
    })

    test('a span ending exactly at the 32,768-character display limit is kept; one past it is not', () => {
      const atLimit = shown([wire('turn.assistant_message', reply(32_768, 32_768), 'a')])
      expect(atLimit.bodyTruncated).toBe(true)
      expect(atLimit.references).toMatchObject({ inline: 'mapped', cited: 1 })
      expect(atLimit.references?.citations).toEqual([{ sourceId: 'book', start: 0, end: 32_768 }])

      const past = shown([wire('turn.assistant_message', reply(32_769, 32_769), 'b')])
      expect(past.references).toMatchObject({ inline: 'mapped', cited: 1 })
      expect(past.references?.citations).toEqual([])
    })

    test('exactly 32 sources and 128 citations are accepted, one more of either is not', () => {
      expect(
        shown([wire('turn.assistant_message', many(32, 128), 'ok')]).references?.sources
      ).toHaveLength(32)
      expect(
        shown([wire('turn.assistant_message', many(33, 128), 'x1')]).references
      ).toBeUndefined()
      expect(
        shown([wire('turn.assistant_message', many(32, 129), 'x2')]).references
      ).toBeUndefined()
    })
  })
})

// ─── One assistant message across its deltas, final text and result (#1383) ─

const delta = (messageId: string, deltaIndex: number, text: string, id: string, run = 'run-1') =>
  event('turn.assistant_delta', { messageId, deltaIndex, text }, id, run)
const final = (messageId: string, text: string, id: string, run = 'run-1') =>
  event('turn.assistant_message', { messageId, text, supersedes: 'deltas' }, id, run)
const result = (messageId: string, id: string, extra: object = {}, run = 'run-1') =>
  event('turn.result', { messageId, ...extra }, id, run)
const shapeOf = (built: ReturnType<typeof turns>['turns']) =>
  built[0]?.entries.map((entry) => `${entry.type}:${entry.id}`)

describe('assistant message identity', () => {
  test('the final text replaces its deltas in their place and under their id', () => {
    const { turns: built, entryByEventId } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'Hel', 'd1'),
      delta('m1', 1, 'lo', 'd2'),
      final('m1', 'Hello, world.', 'a1'),
    ])
    expect(shapeOf(built)).toEqual(['text:d1'])
    expect(built[0]?.entries[0]).toMatchObject({
      type: 'text',
      source: 'message',
      text: 'Hello, world.',
      eventIds: ['d1', 'd2', 'a1'],
    })
    expect(entryByEventId.get('a1')).toBe('d1')
    expect(entryByEventId.get('d2')).toBe('d1')
  })

  test('a final whose deltas are gone is drawn on its own', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      final('m1', 'Hello, world.', 'a1'),
    ])
    expect(shapeOf(built)).toEqual(['text:a1'])
  })

  test('a message interrupted by a tool is one block at its first position', () => {
    const { turns: built, entryByEventId } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'Looking. ', 'd1'),
      event('tool.started', { name: 'bash' }, 't1'),
      delta('m1', 1, 'Found it.', 'd2'),
      final('m1', 'Looking. Found it.', 'a1'),
    ])
    expect(shapeOf(built)).toEqual(['text:d1', 'activity:t1'])
    expect(built[0]?.entries[0]).toMatchObject({
      text: 'Looking. Found it.',
      eventIds: ['d1', 'd2', 'a1'],
    })
    expect(entryByEventId.get('d2')).toBe('d1')
  })

  test('two messages of one run stay two blocks, and each final replaces only its own', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'First', 'd1'),
      delta('m2', 0, 'Second', 'd2'),
      final('m2', 'Second.', 'a2'),
      final('m1', 'First.', 'a1'),
    ])
    expect(shapeOf(built)).toEqual(['text:d1', 'text:d2'])
    expect(built[0]?.entries.map((entry) => (entry as { text: string }).text)).toEqual([
      'First.',
      'Second.',
    ])
  })

  test('the same id from another run, or in another turn, is another message', () => {
    const otherRun = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'one', 'd1'),
      final('m1', 'two', 'a1', 'run-2'),
    ])
    expect(shapeOf(otherRun.turns)).toEqual(['text:d1', 'text:a1'])

    const nextTurn = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'one', 'd1'),
      event('turn.user_input', { text: 'again' }, 'u2'),
      final('m1', 'two', 'a1'),
    ])
    expect(nextTurn.turns.map((turn) => turn.entries.map((entry) => entry.id))).toEqual([
      ['d1'],
      ['a1'],
    ])
  })

  test('a result that references a drawn message ends it and is not a second answer', () => {
    const { turns: built, entryByEventId } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'Done.', 'd1'),
      final('m1', 'Done.', 'a1'),
      result('m1', 'r1'),
    ])
    expect(shapeOf(built)).toEqual(['text:d1'])
    expect(built[0]?.entries[0]).toMatchObject({ failed: false, eventIds: ['d1', 'a1', 'r1'] })
    expect(entryByEventId.get('r1')).toBe('d1')
  })

  test('a failing result marks the message it references as failed', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      final('m1', 'It broke.', 'a1'),
      result('m1', 'r1', { isError: true }),
    ])
    expect(shapeOf(built)).toEqual(['text:a1'])
    expect(built[0]?.entries[0]).toMatchObject({ failed: true })
  })

  test('a result for a message that was never drawn stays visible as a notice', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      result('m1', 'r1'),
    ])
    expect(shapeOf(built)).toEqual(['notice:r1'])
  })

  test('a summary-bearing result ends the message it references and is not another answer', () => {
    const { turns: built, entryByEventId } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'Done.', 'd1'),
      final('m1', 'Done.', 'a1'),
      result('m1', 'r1', { summary: 'Finished in two steps.' }),
    ])
    expect(shapeOf(built)).toEqual(['text:d1'])
    expect(built[0]?.entries[0]).toMatchObject({
      text: 'Done.',
      failed: false,
      summary: 'Finished in two steps.',
      eventIds: ['d1', 'a1', 'r1'],
    })
    expect(entryByEventId.get('r1')).toBe('d1')
  })

  test('a failing summary-bearing result marks the referenced message as failed', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      final('m1', 'It broke.', 'a1'),
      result('m1', 'r1', { summary: 'The build failed.', isError: true }),
    ])
    expect(shapeOf(built)).toEqual(['text:a1'])
    expect(built[0]?.entries[0]).toMatchObject({
      text: 'It broke.',
      failed: true,
      summary: 'The build failed.',
    })
  })

  test('a result that references no drawn message still shows its summary', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      result('m1', 'r1', { summary: 'Finished in two steps.' }),
    ])
    expect(shapeOf(built)).toEqual(['text:r1'])
  })

  test('a final without supersedes does not replace the partials it names', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'Partial answer', 'd1'),
      event('turn.assistant_message', { messageId: 'm1', text: 'Other text.' }, 'a1'),
    ])
    expect(shapeOf(built)).toEqual(['text:d1', 'text:a1'])
    expect(built[0]?.entries.map((entry) => (entry as { text: string }).text)).toEqual([
      'Partial answer',
      'Other text.',
    ])
  })

  test('a final that supersedes something other than deltas does not replace them', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'Partial answer', 'd1'),
      event('turn.assistant_message', { messageId: 'm1', text: 'x', supersedes: 'all' }, 'a1'),
    ])
    expect(shapeOf(built)).toEqual(['text:d1', 'text:a1'])
  })

  test('a result or delta whose identity fails its contract is not paired', () => {
    const badDelta = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('turn.assistant_delta', { messageId: 'm1', deltaIndex: -1, text: 'one' }, 'd1'),
      final('m1', 'two', 'a1'),
    ])
    expect(shapeOf(badDelta.turns)).toEqual(['text:d1', 'text:a1'])

    const badResult = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      final('m1', 'Done.', 'a1'),
      event('turn.result', { messageId: 'm1', summary: 42 }, 'r1'),
    ])
    expect(shapeOf(badResult.turns)).toEqual(['text:a1', 'notice:r1'])
  })

  test('an event that fails the full event contract has no identity, whatever its payload says', () => {
    // The browser envelope does not check the canonical sequence the host contract requires.
    const forged = { ...final('m1', 'forged', 'a1'), seq: 'not-a-sequence' }
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'Real ', 'd1'),
      forged,
    ])
    expect(shapeOf(built)).toEqual(['text:d1', 'text:a1'])
    expect(built[0]?.entries[0]).toMatchObject({ text: 'Real ' })
  })

  test('a valid final with no text replaces the stream it supersedes', () => {
    for (const blank of ['', '  \n ']) {
      const { turns: built, entryByEventId } = turns([
        event('turn.user_input', { text: 'q' }, 'u1'),
        delta('m1', 0, 'Partial answer', 'd1'),
        final('m1', blank, 'a1'),
      ])
      expect(shapeOf(built)).toEqual(['text:d1'])
      expect(built[0]?.entries[0]).toMatchObject({
        source: 'message',
        text: '',
        truncated: false,
        eventIds: ['d1', 'a1'],
      })
      expect(entryByEventId.get('a1')).toBe('d1')
    }
  })

  test('a blank final with nothing to replace stays a visible line', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      final('m1', '', 'a1'),
    ])
    expect(shapeOf(built)).toEqual(['notice:a1'])
  })

  test('a carriage return that ends one message does not take the line feed that starts the next', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'a\r', 'd1'),
      delta('m2', 0, '\nb', 'd2'),
    ])
    expect(shapeOf(built)).toEqual(['text:d1', 'text:d2'])
    expect(built[0]?.entries.map((entry) => (entry as { text: string }).text)).toEqual([
      'a\n',
      '\nb',
    ])
  })

  test('a split carriage return and line feed inside one message still reads as one line break', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'a\r', 'd1'),
      delta('m1', 1, '\nb', 'd2'),
    ])
    expect(shapeOf(built)).toEqual(['text:d1'])
    expect(built[0]?.entries[0]).toMatchObject({ text: 'a\nb' })
  })

  test('a fragment that arrives after the final text joins the message without changing it', () => {
    const { turns: built, entryByEventId } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      delta('m1', 0, 'Hi', 'd1'),
      final('m1', 'Hi there.', 'a1'),
      delta('m1', 1, ' there', 'd2'),
    ])
    expect(shapeOf(built)).toEqual(['text:d1'])
    expect(built[0]?.entries[0]).toMatchObject({
      text: 'Hi there.',
      eventIds: ['d1', 'a1', 'd2'],
    })
    expect(entryByEventId.get('d2')).toBe('d1')
  })
})

// ─── Approval and question outcomes paired with their request (#1383) ───────

// The host admits a structured interaction only with authoritative provenance from an
// owning adapter, workspace_private classification and a run identity.
const interactionEvent = (
  kind: RuntimeEvent['kind'],
  payload: unknown,
  id: string,
  over: Partial<RuntimeEvent> = {}
): RuntimeEvent => ({
  ...event(kind, payload, id),
  source: 'native',
  classification: 'workspace_private',
  ...over,
})
const askApproval = (id: string, requestId = 'req-1', over: Partial<RuntimeEvent> = {}) =>
  interactionEvent(
    'approval.requested',
    {
      schemaVersion: 1,
      requestId,
      eligibility: { eligible: false, reason: 'response_unavailable' },
      prompt: 'Run the tests?',
    },
    id,
    over
  )
const outcomeOf = (
  kind: 'approval.resolved' | 'approval.expired' | 'question.resolved' | 'question.expired',
  id: string,
  requestEventId: string,
  decision: string,
  requestId = 'req-1',
  over: Partial<RuntimeEvent> = {},
  answers: readonly unknown[] = []
) =>
  interactionEvent(
    kind,
    {
      schemaVersion: 1,
      requestId,
      requestEventId,
      decision,
      ...(decision === 'answered' ? { answers } : {}),
    },
    id,
    over
  )
const approvalShape = (built: ReturnType<typeof turns>['turns']) =>
  built[0]?.entries.map((entry) => `${entry.type}:${entry.id}`)

const askQuestions = (over: Partial<RuntimeEvent> = {}) =>
  interactionEvent(
    'question.requested',
    {
      schemaVersion: 1,
      requestId: 'req-1',
      eligibility: { eligible: false, reason: 'response_unavailable' },
      questions: [
        { id: 'target', prompt: 'Which target?', required: true, kind: 'text' },
        {
          id: 'mode',
          prompt: 'Which mode?',
          required: false,
          kind: 'choice',
          multiple: false,
          options: [
            { id: 'fast', label: 'Fast' },
            { id: 'safe', label: 'Safe' },
          ],
        },
      ],
    },
    'q1',
    over
  )
const answeredWith = (answers: readonly unknown[]) =>
  outcomeOf('question.resolved', 'o1', 'q1', 'answered', 'req-1', {}, answers)

describe('approval and question outcomes', () => {
  test('a request says whether this surface may answer it', () => {
    const [row] = projectTranscriptEvents([askApproval('q1')])
    expect(row?.interaction).toEqual({
      phase: 'requested',
      requestId: 'req-1',
      responseAvailable: false,
    })
  })

  test('an outcome that names the request is drawn on it, not as a second line', () => {
    const { turns: built, entryByEventId } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      askApproval('q1'),
      outcomeOf('approval.resolved', 'o1', 'q1', 'approved'),
    ])
    expect(approvalShape(built)).toEqual(['approval:q1'])
    expect(built[0]?.entries[0]).toMatchObject({ outcome: { decision: 'approved', eventId: 'o1' } })
    expect(entryByEventId.get('o1')).toBe('q1')
  })

  test('a denial and an expiry pair the same way', () => {
    const denied = turns([askApproval('q1'), outcomeOf('approval.resolved', 'o1', 'q1', 'denied')])
    expect(denied.turns[0]?.entries[0]).toMatchObject({ outcome: { decision: 'denied' } })
    const expired = turns([askApproval('q1'), outcomeOf('approval.expired', 'o1', 'q1', 'expired')])
    expect(expired.turns[0]?.entries[0]).toMatchObject({ outcome: { decision: 'expired' } })
  })

  test('an outcome with another request id is not paired', () => {
    const { turns: built } = turns([
      askApproval('q1'),
      outcomeOf('approval.resolved', 'o1', 'q1', 'approved', 'req-other'),
    ])
    expect(approvalShape(built)).toEqual(['approval:q1', 'approval:o1'])
    expect(built[0]?.entries[0]).not.toHaveProperty('outcome')
  })

  test('an outcome from another generation or session is not paired', () => {
    const otherGeneration = {
      ...outcomeOf('approval.resolved', 'o1', 'q1', 'approved'),
      generation: 2,
    }
    const otherSession = {
      ...outcomeOf('approval.resolved', 'o2', 'q1', 'approved'),
      runtimeSessionId: 'session-2',
    }
    const { turns: built } = turns([askApproval('q1'), otherGeneration, otherSession])
    expect(approvalShape(built)).toEqual(['approval:q1', 'approval:o1', 'approval:o2'])
    expect(built[0]?.entries[0]).not.toHaveProperty('outcome')
  })

  test('an outcome whose request left the window stays a line of its own', () => {
    const { turns: built } = turns([outcomeOf('approval.resolved', 'o1', 'gone', 'approved')])
    expect(approvalShape(built)).toEqual(['approval:o1'])
  })

  test('the first outcome settles the request and a second stays visible', () => {
    const { turns: built } = turns([
      askApproval('q1'),
      outcomeOf('approval.resolved', 'o1', 'q1', 'approved'),
      outcomeOf('approval.resolved', 'o2', 'q1', 'denied'),
    ])
    expect(approvalShape(built)).toEqual(['approval:q1', 'approval:o2'])
    expect(built[0]?.entries[0]).toMatchObject({ outcome: { decision: 'approved', eventId: 'o1' } })
  })

  test('a question outcome never settles an approval request', () => {
    const { turns: built } = turns([
      askApproval('q1'),
      outcomeOf('question.resolved', 'o1', 'q1', 'answered'),
    ])
    expect(approvalShape(built)).toEqual(['approval:q1', 'question:o1'])
    expect(built[0]?.entries[0]).not.toHaveProperty('outcome')
  })

  describe('an interaction is a fact only as a whole event', () => {
    test('a hint-grade or merely metadata-classified event is not a structured interaction', () => {
      const hinted = askApproval('q1', 'req-1', { confidence: 'untrusted_hint' })
      const metadata = askApproval('q2', 'req-1', { classification: 'workspace_metadata' })
      expect(projectTranscriptEvents([hinted, metadata]).map((row) => row.interaction)).toEqual([
        undefined,
        undefined,
      ])
    })

    test('an outcome that is only a hint never settles the request', () => {
      const { turns: built } = turns([
        askApproval('q1'),
        outcomeOf('approval.resolved', 'o1', 'q1', 'approved', 'req-1', {
          confidence: 'untrusted_hint',
        }),
      ])
      expect(approvalShape(built)).toEqual(['approval:q1', 'approval:o1'])
      expect(built[0]?.entries[0]).not.toHaveProperty('outcome')
    })

    test('a request without a run identity is not structured', () => {
      const [row] = projectTranscriptEvents([
        askApproval('q1', 'req-1', { harnessRunId: undefined }),
      ])
      expect(row?.interaction).toBeUndefined()
    })

    test('an outcome from another source or another run is not this request’s outcome', () => {
      const otherSource = outcomeOf('approval.resolved', 'o1', 'q1', 'approved', 'req-1', {
        source: 'acp',
      })
      const otherRun = outcomeOf('approval.resolved', 'o2', 'q1', 'approved', 'req-1', {
        harnessRunId: 'run-2',
      })
      const { turns: built } = turns([askApproval('q1'), otherSource, otherRun])
      expect(approvalShape(built)).toEqual(['approval:q1', 'approval:o1', 'approval:o2'])
      expect(built[0]?.entries[0]).not.toHaveProperty('outcome')
    })

    test('the same source and run settle it', () => {
      const { turns: built } = turns([
        askApproval('q1', 'req-1', { source: 'acp' }),
        outcomeOf('approval.resolved', 'o1', 'q1', 'approved', 'req-1', { source: 'acp' }),
      ])
      expect(built[0]?.entries[0]).toMatchObject({ outcome: { eventId: 'o1' } })
    })
  })

  describe('a question outcome is checked against the retained request', () => {
    test('answers that satisfy the request settle it', () => {
      const { turns: built } = turns([
        askQuestions(),
        answeredWith([
          { questionId: 'target', text: 'production' },
          { questionId: 'mode', optionIds: ['safe'] },
        ]),
      ])
      expect(built[0]?.entries[0]).toMatchObject({
        outcome: { decision: 'answered', eventId: 'o1' },
      })
    })

    test('an optional question may be skipped or left out', () => {
      const { turns: built } = turns([
        askQuestions(),
        answeredWith([
          { questionId: 'target', text: 'production' },
          { questionId: 'mode', skipped: true },
        ]),
      ])
      expect(built[0]?.entries[0]).toMatchObject({ outcome: { eventId: 'o1' } })
    })

    test.each([
      ['no answers while a question is required', []],
      ['a required question skipped', [{ questionId: 'target', skipped: true }]],
      [
        'a question the request never asked',
        [
          { questionId: 'target', text: 'production' },
          { questionId: 'extra', text: 'x' },
        ],
      ],
      [
        'an option the question does not offer',
        [
          { questionId: 'target', text: 'production' },
          { questionId: 'mode', optionIds: ['turbo'] },
        ],
      ],
      [
        'a choice answered as text',
        [
          { questionId: 'target', text: 'production' },
          { questionId: 'mode', text: 'safe' },
        ],
      ],
    ] as const)('%s does not settle the request', (_name, answers) => {
      const { turns: built } = turns([askQuestions(), answeredWith(answers)])
      expect(approvalShape(built)).toEqual(['question:q1', 'question:o1'])
      expect(built[0]?.entries[0]).not.toHaveProperty('outcome')
    })

    test('an invalid outcome does not use up the request: a valid one still settles it', () => {
      const { turns: built } = turns([
        askQuestions(),
        answeredWith([]),
        outcomeOf('question.resolved', 'o2', 'q1', 'answered', 'req-1', {}, [
          { questionId: 'target', text: 'production' },
        ]),
      ])
      expect(built[0]?.entries[0]).toMatchObject({ outcome: { eventId: 'o2' } })
    })

    test('an expiry carries no answers and settles', () => {
      const { turns: built } = turns([
        askQuestions(),
        outcomeOf('question.expired', 'o1', 'q1', 'expired'),
      ])
      expect(built[0]?.entries[0]).toMatchObject({
        outcome: { decision: 'expired', eventId: 'o1' },
      })
    })
  })

  test('a legacy payload is never paired by what its text says', () => {
    const { turns: built } = turns([
      event('approval.requested', { prompt: 'Run the tests?' }, 'q1'),
      event('approval.resolved', { requestEventId: 'q1', decision: 'approved' }, 'o1'),
    ])
    expect(approvalShape(built)).toEqual(['approval:q1', 'approval:o1'])
    expect(built[0]?.entries[0]).not.toHaveProperty('outcome')
  })
})
