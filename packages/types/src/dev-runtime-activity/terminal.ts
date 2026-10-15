import {
  fail,
  integerValue,
  literal,
  stringValue,
  uint64String,
} from '../dev-runtime-validation-internal'
import {
  activityCount,
  activityId,
  activityPath,
  activityVersion,
  optionalText,
} from './validation'

export type RuntimeTerminalOutputPayload = Readonly<{
  schemaVersion: 1
  terminalId: string
  commandId: string
  sequence: string
  phase: 'started' | 'output' | 'finished'
  status: 'unknown' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  stream: 'stdout' | 'stderr' | 'combined'
  text?: string
  command?: string
  cwd?: string
  exitCode?: number
  durationMs?: number
}>

export function validateTerminalPayload(value: unknown, path: string): void {
  const item = activityVersion(
    value,
    path,
    ['terminalId', 'commandId', 'sequence', 'phase', 'status', 'stream'],
    ['text', 'command', 'cwd', 'exitCode', 'durationMs']
  )
  activityId(item.terminalId, `${path}.terminalId`)
  activityId(item.commandId, `${path}.commandId`)
  uint64String(item.sequence, `${path}.sequence`)
  literal(item.phase, ['started', 'output', 'finished'], `${path}.phase`)
  literal(item.stream, ['stdout', 'stderr', 'combined'], `${path}.stream`)
  literal(
    item.status,
    item.phase === 'finished'
      ? ['unknown', 'succeeded', 'failed', 'cancelled']
      : ['unknown', 'running'],
    `${path}.status`
  )
  if (item.phase === 'output' || Object.hasOwn(item, 'text'))
    stringValue(item.text, `${path}.text`, 0, 16_384)
  optionalText(item, 'command', path, 8192)
  if (item.cwd !== undefined) activityPath(item.cwd, `${path}.cwd`, true)
  if (item.exitCode !== undefined) {
    if (item.phase !== 'finished') fail(`${path}.exitCode`, 'requires a finished observation')
    integerValue(item.exitCode, `${path}.exitCode`, -2147483648, 2147483647)
  }
  if (item.durationMs !== undefined) activityCount(item.durationMs, `${path}.durationMs`)
}
