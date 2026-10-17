// Public summaries only (#1388). Never derives content, duration or status
// from private reasoning, elapsed host time, tools or completed runs.
import {
  exactKeys,
  fail,
  integerValue,
  literal,
  record,
  stringValue,
} from './dev-runtime-validation-internal'

export const VISIBLE_SUMMARY_BYTES_MAX = 16 * 1024
export const VISIBLE_SUMMARY_TEXT_MAX = 4096
export const VISIBLE_SUMMARY_DURATION_MAX_MS = 86_400_000
export const visibleSummaryKinds = ['turn.reasoning_summary', 'turn.method_step_summary'] as const
export type RuntimeVisibleSummaryKind = (typeof visibleSummaryKinds)[number]
export type RuntimeReasoningSummaryStatus =
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'
export type RuntimeMethodStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'

type SummarySnapshot = Readonly<{
  schemaVersion: 1
  provenance: 'source_reported'
  visibility: 'user_visible'
  format: 'snapshot'
  /** Monotonic snapshot revision within its scoped source identity. */
  revision: number
  text: string
  /** Source-reported elapsed time while active, final duration when terminal. */
  durationMs?: number
}>
export type RuntimeReasoningSummary = SummarySnapshot &
  Readonly<{
    summaryId: string
    status: RuntimeReasoningSummaryStatus
  }>
export type RuntimeMethodStepSummary = SummarySnapshot &
  Readonly<{
    methodId: string
    stepId: string
    position: number
    title: string
    status: RuntimeMethodStepStatus
  }>
export type RuntimeVisibleSummary = RuntimeReasoningSummary | RuntimeMethodStepSummary

export function isRuntimeVisibleSummaryKind(kind: string): kind is RuntimeVisibleSummaryKind {
  return (visibleSummaryKinds as readonly string[]).includes(kind)
}

function identifier(value: unknown, path: string): void {
  const id = stringValue(value, path, 1, 128)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id)) fail(path, 'expected bounded opaque ID')
}

function visibleText(value: unknown, path: string, max: number): string {
  const text = stringValue(value, path, 0, max)
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(path, 'unpaired surrogate')
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) fail(path, 'unpaired surrogate')
  }
  return text
}

/** Structural acceptance on an already canonical producer/wire/replay event.
 * The producer must separately verify the actual authenticated source observation.
 * Payload labels alone are never an admission proof.
 */
export function decodeRuntimeVisibleSummary(
  kind: RuntimeVisibleSummaryKind,
  value: unknown
): RuntimeVisibleSummary {
  literal(kind, visibleSummaryKinds, 'event.summary.kind')
  const path = 'event.summary'
  const item = record(value, path)
  const common = [
    'schemaVersion',
    'provenance',
    'visibility',
    'format',
    'revision',
    'text',
    'status',
  ]
  const reasoning = kind === 'turn.reasoning_summary'
  exactKeys(
    item,
    [...common, ...(reasoning ? ['summaryId'] : ['methodId', 'stepId', 'position', 'title'])],
    ['durationMs'],
    path
  )
  if (item.schemaVersion !== 1) fail(path, 'expected summary schema version 1')
  literal(item.provenance, ['source_reported'], `${path}.provenance`)
  literal(item.visibility, ['user_visible'], `${path}.visibility`)
  literal(item.format, ['snapshot'], `${path}.format`)
  integerValue(item.revision, `${path}.revision`, 0, 2 ** 31 - 1)
  visibleText(item.text, `${path}.text`, VISIBLE_SUMMARY_TEXT_MAX)
  if (reasoning) identifier(item.summaryId, `${path}.summaryId`)
  else {
    identifier(item.methodId, `${path}.methodId`)
    identifier(item.stepId, `${path}.stepId`)
    integerValue(item.position, `${path}.position`, 0, 127)
    if (!visibleText(item.title, `${path}.title`, 512).trim())
      fail(`${path}.title`, 'expected nonblank title')
  }
  literal(
    item.status,
    reasoning
      ? ['streaming', 'completed', 'failed', 'cancelled', 'unknown']
      : ['pending', 'running', 'completed', 'failed', 'cancelled', 'unknown'],
    `${path}.status`
  )
  if ('durationMs' in item) {
    integerValue(item.durationMs, `${path}.durationMs`, 0, VISIBLE_SUMMARY_DURATION_MAX_MS)
    if (item.status === 'pending' || item.status === 'unknown')
      fail(`${path}.durationMs`, 'duration is unknown for this status')
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > VISIBLE_SUMMARY_BYTES_MAX)
    fail(path, 'maximum summary encoded size exceeded')
  return value as RuntimeVisibleSummary
}

export function validateRuntimeVisibleSummaryEvent(event: {
  kind: string
  payload: unknown
  source: unknown
  harnessRunId?: unknown
  confidence: unknown
  classification: unknown
}): void {
  if (!isRuntimeVisibleSummaryKind(event.kind)) return
  literal(event.source, ['native', 'acp', 'authenticated_hook'], 'event.summary.source')
  literal(event.confidence, ['authoritative'], 'event.summary.confidence')
  literal(
    event.classification,
    ['public', 'workspace_private', 'restricted_local'],
    'event.summary.classification'
  )
  stringValue(event.harnessRunId, 'event.summary.harnessRunId', 1, 256)
  decodeRuntimeVisibleSummary(event.kind, event.payload)
}
