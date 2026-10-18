// Canonical event windows for the ChatView visual fixture. Everything here is a
// plausible RuntimeEvent a host could deliver today: only the payload keys the
// chat reads (`text`, `name`, `summary`, `question`, `isError`) are used, and
// nothing models data no producer sends (no checkpoints or token counts). Tool and
// subagent calls carry the identity the merged call contract admits (#1387).
// Source-reported summaries and cited responses use the exact
// payloads the merged wire contracts admit (#1388 and #1389).
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
    payload:
      kind === 'turn.assistant_message' && payload !== null && typeof payload === 'object'
        ? { messageId: `message-${eventId}`, supersedes: 'deltas', ...payload }
        : payload,
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

/** The decisive part of this request sits past the 400 characters a card description shows. */
const call = (
  seq: string,
  kind: RuntimeEvent['kind'],
  payload: Record<string, unknown>,
  eventId: string,
  inline = false
): RuntimeEvent => ({
  ...event(seq, kind, { schemaVersion: 1, permissionEligibility: 'unknown', ...payload }, eventId),
  // Inline call content is restricted to the machine that produced it.
  classification: inline ? 'restricted_local' : 'workspace_private',
})

/**
 * Tool and subagent calls with the identity the merged call contract (#1387) adds:
 * a subagent that parents two tools, a tool that failed inside it, a root tool whose
 * last word is still running, and a call whose parent never arrived.
 */
export const callEvents: readonly RuntimeEvent[] = [
  event('1', 'turn.user_input', { text: 'Review the change with a subagent.' }),
  call(
    '2',
    'subagent.observed',
    { callId: 'agent-1', parentCallId: null, phase: 'started', name: 'reviewer' },
    'call-agent-start'
  ),
  call(
    '3',
    'tool.started',
    { callId: 'read-1', parentCallId: 'agent-1', phase: 'started', name: 'read_file' },
    'call-read-start'
  ),
  call(
    '4',
    'tool.completed',
    {
      callId: 'read-1',
      parentCallId: 'agent-1',
      phase: 'completed',
      durationMs: 420,
      input: { type: 'inline', value: { path: 'packages/db/migrations/0055.sql' } },
      output: { type: 'inline', value: { lines: 48 } },
    },
    'call-read-done',
    true
  ),
  call(
    '5',
    'tool.failed',
    {
      callId: 'test-1',
      parentCallId: 'agent-1',
      phase: 'failed',
      name: 'bun_test',
      durationMs: 1070,
      output: { type: 'reference', referenceId: 'blob-test-1', byteLength: 4096 },
    },
    'call-test-failed'
  ),
  call(
    '6',
    'subagent.observed',
    { callId: 'agent-1', parentCallId: null, phase: 'completed', durationMs: 2400 },
    'call-agent-done'
  ),
  call(
    '7',
    'tool.progress',
    { callId: 'lint-1', phase: 'progress', name: 'oxlint' },
    'call-lint-progress'
  ),
  call(
    '8',
    'tool.completed',
    { callId: 'orphan-1', parentCallId: 'lost-parent', phase: 'completed', name: 'format' },
    'call-orphan-done'
  ),
  event('9', 'turn.assistant_message', { text: 'The reviewer found one failing test.' }),
]

const result = (
  seq: string,
  kind: RuntimeEvent['kind'],
  payload: Record<string, unknown>,
  eventId: string
): RuntimeEvent => event(seq, kind, { schemaVersion: 1, ...payload }, eventId)

/**
 * Structured results with the payloads the merged activity contract admits (#1394):
 * a command's output, a failing test run with a stack, changed files, a plan and a task.
 */
export const resultEvents: readonly RuntimeEvent[] = [
  event('1', 'turn.user_input', { text: 'Run the tests and plan the fix.' }),
  result(
    '2',
    'terminal.output',
    {
      terminalId: 'term-1',
      commandId: 'cmd-1',
      sequence: '1',
      phase: 'started',
      status: 'running',
      stream: 'combined',
      command: 'bun test packages/db',
    },
    'res-term-start'
  ),
  result(
    '3',
    'terminal.output',
    {
      terminalId: 'term-1',
      commandId: 'cmd-1',
      sequence: '2',
      phase: 'output',
      status: 'running',
      stream: 'stdout',
      text: '(pass) applies every migration twice\n(fail) keeps applied history across a rebase\n',
    },
    'res-term-out'
  ),
  result(
    '4',
    'terminal.output',
    {
      terminalId: 'term-1',
      commandId: 'cmd-1',
      sequence: '3',
      phase: 'finished',
      status: 'failed',
      stream: 'combined',
      exitCode: 1,
      durationMs: 1070,
    },
    'res-term-end'
  ),
  result(
    '5',
    'test_run.observed',
    {
      testRunId: 'run-1',
      status: 'failed',
      summary: { passed: 3, failed: 1 },
      tests: [
        { testId: 't-1', name: 'applies every migration twice', status: 'passed' },
        {
          testId: 't-2',
          name: 'keeps applied history across a rebase',
          status: 'failed',
          failureIds: ['f-1'],
        },
      ],
      failures: [
        {
          failureId: 'f-1',
          name: 'AssertionError',
          message: 'expected journal entry 0054 to be unchanged',
          testId: 't-2',
          stack: {
            frames: [
              {
                functionName: 'compareJournal',
                path: 'packages/db/src/journal.ts',
                line: 41,
                column: 9,
              },
              { native: true },
            ],
          },
        },
      ],
    },
    'res-tests'
  ),
  result(
    '6',
    'files.changed',
    {
      changeSetId: 'changes-1',
      files: [
        { path: 'packages/db/src/journal.ts', change: 'modified', additions: 12, deletions: 3 },
        {
          path: 'packages/db/src/journal-check.ts',
          change: 'renamed',
          previousPath: 'packages/db/src/check.ts',
        },
      ],
      summary: { files: 2, additions: 12, deletions: 3 },
    },
    'res-files'
  ),
  result(
    '7',
    'plan.observed',
    {
      planId: 'plan-1',
      status: 'in_progress',
      title: 'Fix the journal check',
      items: [
        { id: 'i-1', title: 'Reproduce the failure', status: 'completed' },
        { id: 'i-2', title: 'Keep applied entries unchanged', status: 'in_progress' },
        { id: 'i-3', title: 'Add a regression test', status: 'pending' },
      ],
    },
    'res-plan'
  ),
  result(
    '8',
    'task.observed',
    { taskId: 'task-1', title: 'Follow up on the rollout order', status: 'pending' },
    'res-task'
  ),
  event('9', 'turn.assistant_message', { text: 'One migration test fails; the plan is above.' }),
]

export const LONG_APPROVAL_TAIL = 'FINAL STEP: drop table audit_log (irreversible)'
export const longApprovalEvents: readonly RuntimeEvent[] = [
  event('1', 'turn.user_input', { text: 'Clean up the audit tables.' }),
  event('2', 'approval.requested', {
    name: 'Run cleanup plan',
    text: `${'Review each step of the cleanup plan before it runs. '.repeat(12)}${LONG_APPROVAL_TAIL}`,
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

const SUMMARY_CLASSIFICATION = 'workspace_private' as const

function reasoningSummary(
  seq: string,
  revision: number,
  text: string,
  status: 'streaming' | 'completed' | 'failed' | 'cancelled' | 'unknown',
  extra: { summaryId?: string; durationMs?: number; eventId?: string } = {}
): RuntimeEvent {
  return {
    ...fixtureEvent(
      seq,
      'turn.reasoning_summary',
      {
        schemaVersion: 1,
        provenance: 'source_reported',
        visibility: 'user_visible',
        format: 'snapshot',
        revision,
        summaryId: extra.summaryId ?? 'think-1',
        text,
        status,
        ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
      },
      extra.eventId
    ),
    classification: SUMMARY_CLASSIFICATION,
  }
}

function methodStep(
  seq: string,
  revision: number,
  step: { id: string; position: number; title: string },
  text: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown',
  durationMs?: number
): RuntimeEvent {
  return {
    ...fixtureEvent(seq, 'turn.method_step_summary', {
      schemaVersion: 1,
      provenance: 'source_reported',
      visibility: 'user_visible',
      format: 'snapshot',
      revision,
      methodId: 'method-1',
      stepId: step.id,
      position: step.position,
      title: step.title,
      text,
      status,
      ...(durationMs !== undefined ? { durationMs } : {}),
    }),
    classification: SUMMARY_CLASSIFICATION,
  }
}

const GROUNDED_REPLY = [
  'Rust needs no garbage collector because ownership decides when a value is freed.',
  'Each value has one owner, and it is dropped when that owner goes out of scope.',
  '',
  'Borrowing lets code read a value without owning it:',
  '',
  '```rust',
  'let s = String::from("hi");',
  'let r = &s;',
  '```',
  '',
  'The compiler checks borrows at compile time, so there is no runtime cost.',
].join('\n')

const endOf = (needle: string) => GROUNDED_REPLY.indexOf(needle) + needle.length

export const GROUNDED_SOURCES = [
  {
    id: 'book-ownership',
    title: 'What is Ownership? - The Rust Programming Language',
    url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html',
    snippet: 'Rust uses a third approach: memory is managed through a system of ownership.',
  },
  {
    id: 'book-borrowing',
    title: 'References and Borrowing',
    url: 'https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html',
  },
] as const

const groundedMessage = (seq: string) =>
  fixtureEvent(
    seq,
    'turn.assistant_message',
    {
      text: GROUNDED_REPLY,
      references: {
        schemaVersion: 1,
        sources: GROUNDED_SOURCES,
        citations: [
          { sourceId: 'book-ownership', start: 0, end: endOf('is freed.') },
          { sourceId: 'book-ownership', start: 0, end: endOf('out of scope.') },
          // Ends where the span above ends: one shared badge, both spans represented.
          {
            sourceId: 'book-borrowing',
            start: GROUNDED_REPLY.indexOf('Each value'),
            end: endOf('out of scope.'),
          },
          {
            sourceId: 'book-borrowing',
            start: GROUNDED_REPLY.indexOf('Borrowing'),
            end: endOf('owning it:'),
          },
          // Inside the fenced block: the producer may cite it, the canvas will not put a badge in code.
          {
            sourceId: 'book-borrowing',
            start: GROUNDED_REPLY.indexOf('let r'),
            end: endOf('let r = &s;'),
          },
        ],
      },
    },
    'chat-visual-grounded-answer'
  )

export const groundedPrompt = fixtureEvent('1', 'turn.user_input', {
  text: 'Does Rust need a garbage collector? Cite your sources.',
})

/** One scripted step per `chat-visual:append`; each receives the next sequence number. */
export const groundedScript: readonly ((seq: string) => RuntimeEvent)[] = [
  (seq) =>
    reasoningSummary(seq, 1, 'Checking what the Rust book says about memory.', 'streaming', {
      eventId: 'chat-visual-think-1',
    }),
  (seq) =>
    methodStep(seq, 1, { id: 'search', position: 0, title: 'Search the Rust book' }, '', 'running'),
  (seq) =>
    reasoningSummary(
      seq,
      2,
      'Checking what the Rust book says about memory.\n\nOwnership and borrowing are the two chapters that matter.',
      'streaming'
    ),
  (seq) =>
    methodStep(
      seq,
      2,
      { id: 'search', position: 0, title: 'Search the Rust book' },
      'Chapter 4 covers ownership and borrowing.',
      'completed',
      1800
    ),
  (seq) =>
    methodStep(seq, 1, { id: 'compare', position: 1, title: 'Compare the claims' }, '', 'running'),
  (seq) =>
    reasoningSummary(
      seq,
      3,
      'Checking what the Rust book says about memory.\n\nOwnership and borrowing are the two chapters that matter.',
      'completed',
      { durationMs: 4200 }
    ),
  (seq) =>
    methodStep(
      seq,
      2,
      { id: 'compare', position: 1, title: 'Compare the claims' },
      'Both claims match the book.',
      'completed',
      900
    ),
  groundedMessage,
]

/** The grounded conversation after the script has run: nothing left in flight. */
export const groundedEvents: readonly RuntimeEvent[] = [
  groundedPrompt,
  ...groundedScript.map((step, index) => step(String(index + 2))),
]

/** The producer's last word was "streaming" and the session then stopped: nothing may spin. */
export const groundedStoppedEvents: readonly RuntimeEvent[] = [
  groundedPrompt,
  reasoningSummary('2', 1, 'Checking what the Rust book says about memory.', 'streaming', {
    eventId: 'chat-visual-stopped-think',
  }),
  methodStep(
    '3',
    1,
    { id: 'search', position: 0, title: 'Search the Rust book' },
    'Reading chapter 4.',
    'running'
  ),
  fixtureEvent('4', 'session.cancelled', {
    name: 'Session cancelled',
    text: 'Stopped from the composer.',
  }),
]

/** Untrusted text in every field a producer can fill. */
export const groundedHostileEvents: readonly RuntimeEvent[] = [
  fixtureEvent('1', 'turn.user_input', { text: 'Summarise the page.' }),
  reasoningSummary(
    '2',
    1,
    '<script>window.pwned = true</script> **kept as text** [click](javascript:window.pwned=true) key sk-supersecretvalue1234 in /Users/example/private',
    'completed',
    { eventId: 'chat-visual-hostile-think', durationMs: 900 }
  ),
  methodStep(
    '3',
    1,
    { id: 'one', position: 0, title: '<img src=x onerror=alert(1)> step title' },
    'Fetched /Users/example/notes and Bearer abcdefghijklmnop1234',
    'completed'
  ),
  fixtureEvent(
    '4',
    'turn.assistant_message',
    {
      text: 'Per the page, it is hostile. See the source.',
      references: {
        schemaVersion: 1,
        sources: [
          {
            id: 'hostile-source',
            // A direction override and a long title: both are bounded and cleaned on display.
            title: `\u202eevil.example ${'long title '.repeat(40)}`,
            url: 'https://evil.example/path?q=1',
            snippet: '<b>not bold</b> javascript:alert(1)',
          },
          {
            // Secrets in every field: the title and snippet are redacted, and a link the
            // redaction would change is not shown as a link at all.
            id: 'canary-source',
            title: 'Report sk-supersecretvalue1234',
            url: 'https://canary.example/cb?token_abcdefgh12345',
            snippet: 'Saved to /Users/example/secret with Bearer abcdefghijklmnop1234',
          },
        ],
        // Both spans end together, so they share one badge and both are represented.
        citations: [
          { sourceId: 'hostile-source', start: 0, end: 18 },
          { sourceId: 'canary-source', start: 4, end: 18 },
        ],
      },
    },
    'chat-visual-hostile-answer'
  ),
]

/**
 * Retention: a window that fills and then drops its oldest event for each new one.
 * Both start with the prompt (the first event to be evicted) and a collapsed
 * reasoning line, a disclosure the reader can open and a text to select.
 */
export const RETENTION_FILLER_ID = 'chat-visual-filler'
export const retentionTurnEvents: readonly RuntimeEvent[] = [
  fixtureEvent('1', 'turn.user_input', { text: 'Clean up the audit tables.' }),
  fixtureEvent('2', 'tool.started', { name: 'workspace.search' }, RETENTION_FILLER_ID),
  reasoningSummary('3', 1, 'Reviewed the cleanup plan against the retention rules.', 'completed', {
    summaryId: 'retention-think',
    durationMs: 2000,
    eventId: 'chat-visual-retention-think',
  }),
]
/** One more activity line per event, so the reply's own events fill the window. */
export const retentionTurnScript = (seq: string): RuntimeEvent =>
  fixtureEvent(seq, 'tool.completed', { name: `step ${seq}`, summary: `Finished step ${seq}.` })

export const retentionStreamEvents: readonly RuntimeEvent[] = [
  fixtureEvent('1', 'turn.user_input', { text: 'Explain the cleanup in detail.' }),
  reasoningSummary('2', 1, 'Reviewed the cleanup plan against the retention rules.', 'completed', {
    summaryId: 'retention-think',
    durationMs: 2000,
    eventId: 'chat-visual-retention-think',
  }),
]
/**
 * A letters-only word for a sequence number: digits inside prose read as secret
 * material to the redaction heuristics, which would split the reply into several
 * blocks and hide what this fixture is for (one block, drawn far past the window).
 */
export const retentionWord = (seq: string): string =>
  `w${[...seq].map((digit) => String.fromCodePoint(97 + Number(digit))).join('')}`

/** A single reply streamed as one delta per event, far past the window. */
export const retentionStreamScript = (seq: string): RuntimeEvent =>
  fixtureEvent(
    seq,
    'turn.assistant_delta',
    { text: `${retentionWord(seq)} ` },
    `chat-visual-d${seq}`
  )
