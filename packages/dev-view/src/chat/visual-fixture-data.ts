// Canonical event windows for the ChatView visual fixture. Everything here is a
// plausible RuntimeEvent a host could deliver today: only the payload keys the
// chat reads (`text`, `name`, `summary`, `question`, `isError`) are used, and
// nothing models data no producer sends (no citations, checkpoints, reasoning,
// token counts or call identities).
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

export const FIXTURE_SESSION_ID = '00000000-0000-4000-8000-000000000004'

export function fixtureEvent(
  seq: string,
  kind: RuntimeEvent['kind'],
  payload: unknown,
  eventId = `chat-visual-${seq}`,
  harnessRunId = '00000000-0000-4000-8000-000000000009'
): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId,
    runtimeSessionId: FIXTURE_SESSION_ID,
    harnessRunId,
    generation: 3,
    seq,
    occurredAt: '2026-09-22T10:00:00.000Z',
    receivedAt: '2026-09-22T10:00:00.000Z',
    source: 'native',
    sourceEventId: eventId,
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind,
    payload,
  }
}

const event = fixtureEvent

/** A command's output long enough to need its own bounded, scrollable block. */
export const FIXTURE_TEST_OUTPUT = [
  '$ bun test packages/db',
  'bun test v1.4.2',
  '',
  'tests/migrations.test.ts:',
  '(pass) applies every migration twice [412.31ms]',
  '(pass) keeps the journal append-only [38.02ms]',
  '(pass) rejects a renumbered migration [21.77ms]',
  '(fail) preserves applied history across a rebase [96.40ms]',
  '  error: expected journal entry 0054 to be unchanged',
  '',
  ' 3 pass',
  ' 1 fail',
  'Ran 4 tests across 1 file. [1.07s]',
].join('\n')

const REPORT_REPLY = [
  'The plan is **mostly safe**. Two things need a decision before it ships:',
  '',
  '- The `0055` migration renumbers an applied entry, which the journal check rejects.',
  '- The rollout has no stated order between the web and the worker deploys.',
  '',
  'This is the failing assertion, from `packages/db/tests/migrations.test.ts`:',
  '',
  '```ts',
  "expect(journal.entries[54].tag).toBe('0054_pi_durable_leases')",
  '```',
  '',
  'Notes are in [the runbook](https://example.com/runbook). A [script link](javascript:alert(1)) is shown as text, never followed.',
].join('\n')

export const richEvents: readonly RuntimeEvent[] = [
  event('1', 'session.ready', { name: 'Session ready' }),
  event('2', 'turn.user_input', {
    text: 'Review the deployment plan, run the migration tests, and summarize the risks.',
  }),
  event('3', 'tool.started', { name: 'workspace.search', text: 'Searching the project notes…' }),
  event('4', 'tool.completed', { name: 'workspace.search', summary: 'Found 4 relevant notes.' }),
  event('5', 'tool.started', { name: 'bash', text: 'bun test packages/db' }),
  event('6', 'tool.failed', { name: 'bash', text: FIXTURE_TEST_OUTPUT }),
  event('7', 'subagent.observed', {
    name: 'migration-reviewer',
    text: 'Reviewing journal 0050-0056',
  }),
  event('8', 'file.observed', {
    path: '/Users/example/adea/packages/db/drizzle/meta/_journal.json',
  }),
  event('9', 'turn.assistant_message', { text: REPORT_REPLY }, 'chat-visual-report'),
  event('10', 'turn.result', { summary: 'Review finished with 1 failing test.' }),
  event('11', 'turn.user_input', { text: 'Apply the fix and rerun the migrations.' }),
  event('12', 'approval.requested', {
    name: 'Apply migration plan',
    text: 'The runtime is waiting for approval to apply the reviewed changes.',
  }),
  event('13', 'question.requested', {
    name: 'Target environment',
    question: 'Which environment should receive the reviewed changes?',
  }),
]

export const hostileEvents: readonly RuntimeEvent[] = [
  event('1', 'turn.user_input', {
    text: '<img src=x onerror=alert(1)> **not bold** [x](javascript:alert(1))',
  }),
  event('2', 'turn.assistant_message', {
    text: [
      '<script>window.pwned = true</script> <b>literal tags</b>',
      '',
      '[click](javascript:window.pwned=true) and [ok](https://example.com)',
      '',
      `A very long unbroken token: ${'x'.repeat(400)}`,
      '',
      '```zzz-unknown-language',
      '<div onclick="steal()">kept as text</div>',
      '```',
    ].join('\n'),
  }),
  event('3', 'tool.completed', {
    name: '<b>bold name</b>',
    text: 'API key sk-supersecretvalue1234 in /Users/example/private',
  }),
  event('4', 'wat.is.this' as RuntimeEvent['kind'], {
    text: 'an event kind this build has never heard of',
  }),
]

export const failedEvents: readonly RuntimeEvent[] = [
  event('1', 'turn.user_input', { text: 'Run the full verification.' }),
  event('2', 'tool.started', { name: 'bash', text: 'bun run verify' }),
  event('3', 'tool.failed', { name: 'bash', text: 'verify exited with code 1' }),
  event('4', 'turn.result', { text: 'The verification did not pass.', isError: true }),
  event('5', 'session.failed', {
    name: 'Session failed',
    text: 'The harness exited unexpectedly.',
  }),
]

export const cancelledEvents: readonly RuntimeEvent[] = [
  event('1', 'turn.user_input', { text: 'Rewrite the release notes.' }),
  event('2', 'turn.assistant_delta', { text: 'Starting with the summary section, then' }),
  event('3', 'session.cancelled', {
    name: 'Session cancelled',
    text: 'Stopped from the composer.',
  }),
]

/**
 * Deltas appended one per `chat-visual:append`: a code fence that opens in one
 * fragment and closes in a later one, so a spec can observe a partial block.
 */
export const codeStreamTexts: readonly string[] = [
  'Here is the change:\n\n```ts\nexport function add(a: number, b: number) {\n',
  '  return a + b\n}\n```\n\nThat is all.',
  // Later fragments are long enough to overflow a short pane, so a spec can
  // observe whether the reader is followed or left where they scrolled to.
  `\n\n${'Later paragraph one. '.repeat(40)}`,
  `\n\n${'Later paragraph two. '.repeat(40)}`,
]

const largeLines = Array.from(
  { length: 2_500 },
  (_, index) => `line ${String(index + 1).padStart(4, '0')}`
)

/** Output far past every bound: a 2,500-line block, and prose longer than a message may be. */
export const largeEvents: readonly RuntimeEvent[] = [
  event('1', 'turn.user_input', { text: 'Print the whole log.' }),
  event('2', 'turn.assistant_message', {
    text: `The log, in full:\n\n\`\`\`text\n${largeLines.join('\n')}\n\`\`\``,
  }),
  event('3', 'turn.assistant_message', { text: 'word '.repeat(10_000) }),
]

/** A fenced block whose source has whitespace a copy must not alter. */
export const FIXTURE_EXACT_SOURCE = ['if (a) {', '\treturn  b;   ', '}', '', '  trailing  '].join(
  '\n'
)

export const copyEvents: readonly RuntimeEvent[] = [
  event('1', 'turn.user_input', { text: 'Show the snippet.' }),
  event('2', 'turn.assistant_message', {
    text: `Here it is:\n\n\`\`\`js\n${FIXTURE_EXACT_SOURCE}\n\`\`\`\n\nDone.`,
  }),
]
