import {
  exactKeys,
  fail,
  finiteNumber,
  integerValue,
  literal,
  record,
  sha256Pattern,
  stringValue,
} from './dev-runtime-validation-internal'
import { assertJsonUnicode } from './dev-runtime-unicode'

export const runtimeCallEventKinds = [
  'tool.requested',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'tool.failed',
  'subagent.observed',
] as const
export type RuntimeCallEventKind = (typeof runtimeCallEventKinds)[number]
export const runtimeCallPhases = [
  'requested',
  'started',
  'progress',
  'completed',
  'failed',
  'cancelled',
] as const
export type RuntimeCallPhase = (typeof runtimeCallPhases)[number]

/** An observation, never an authorization grant or proof of noninteractive content. */
export type RuntimeCallPermissionEligibility = 'unknown' | 'requires_approval' | 'not_required'
export type RuntimeCallJson =
  | null
  | boolean
  | number
  | string
  | readonly RuntimeCallJson[]
  | { readonly [key: string]: RuntimeCallJson }
export type RuntimeCallData =
  | Readonly<{ type: 'inline'; value: RuntimeCallJson }>
  | Readonly<{ type: 'reference'; referenceId: string; byteLength?: number; sha256?: string }>

export type RuntimeCallPayload = Readonly<{
  schemaVersion: 1
  /** Stable within (runtime session, generation, harness run, source). */
  callId: string
  /** Absent: unknown. Null: the producer explicitly observed a root call. */
  parentCallId?: string | null
  phase: RuntimeCallPhase
  permissionEligibility: RuntimeCallPermissionEligibility
  name?: string
  input?: RuntimeCallData
  output?: RuntimeCallData
  /** Observed elapsed milliseconds, never inferred from receive timestamps. */
  durationMs?: number
}>

export const RUNTIME_CALL_INLINE_BYTES_MAX = 32 * 1024
export const RUNTIME_CALL_JSON_NODES_MAX = 2048
export const RUNTIME_CALL_JSON_DEPTH_MAX = 16
export const RUNTIME_CALL_JSON_ENTRIES_MAX = 256
export const RUNTIME_CALL_JSON_STRING_MAX = 16 * 1024

export function isRuntimeCallEventKind(kind: unknown): kind is RuntimeCallEventKind {
  return runtimeCallEventKinds.includes(kind as RuntimeCallEventKind)
}

function callId(value: unknown, path: string): string {
  const text = stringValue(value, path, 1, 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) fail(path, 'expected opaque call identifier')
  return text
}

function validateInline(value: unknown, path: string): void {
  let remaining = RUNTIME_CALL_JSON_NODES_MAX
  const visit = (entry: unknown, location: string, depth: number): void => {
    if (--remaining < 0) fail(location, 'maximum JSON node count exceeded')
    if (depth > RUNTIME_CALL_JSON_DEPTH_MAX) fail(location, 'maximum JSON depth exceeded')
    if (entry === null || typeof entry === 'boolean') return
    if (typeof entry === 'number') {
      finiteNumber(entry, location)
      return
    }
    if (typeof entry === 'string') {
      stringValue(entry, location, 0, RUNTIME_CALL_JSON_STRING_MAX)
      return
    }
    if (Array.isArray(entry)) {
      if (entry.length > RUNTIME_CALL_JSON_ENTRIES_MAX)
        fail(location, 'maximum array length exceeded')
      for (let index = 0; index < entry.length; index += 1) {
        if (!Object.hasOwn(entry, index)) fail(location, 'sparse arrays are not JSON')
        visit(entry[index], `${location}[${index}]`, depth + 1)
      }
      return
    }
    const object = record(entry, location)
    const keys = Object.keys(object)
    if (keys.length > RUNTIME_CALL_JSON_ENTRIES_MAX)
      fail(location, 'maximum object entries exceeded')
    for (const key of keys) {
      stringValue(key, `${location} key`, 1, 256)
      visit(object[key], `${location}.${key}`, depth + 1)
    }
  }
  visit(value, path, 0)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > RUNTIME_CALL_INLINE_BYTES_MAX)
    fail(path, 'maximum inline encoded size exceeded')
}

function decodeData(value: unknown, path: string): void {
  const item = record(value, path)
  literal(item.type, ['inline', 'reference'], `${path}.type`)
  if (item.type === 'inline') {
    exactKeys(item, ['type', 'value'], [], path)
    validateInline(item.value, `${path}.value`)
  } else {
    exactKeys(item, ['type', 'referenceId'], ['byteLength', 'sha256'], path)
    callId(item.referenceId, `${path}.referenceId`)
    if (item.byteLength !== undefined) integerValue(item.byteLength, `${path}.byteLength`, 0)
    if (
      item.sha256 !== undefined &&
      !sha256Pattern.test(stringValue(item.sha256, `${path}.sha256`))
    )
      fail(`${path}.sha256`, 'expected lowercase SHA-256')
  }
}

/** Shape validation only; the event decoder also checks transport and confidence. */
export function decodeRuntimeCallPayload(
  value: unknown,
  kind: RuntimeCallEventKind
): RuntimeCallPayload {
  if (!isRuntimeCallEventKind(kind)) fail('event.kind', 'expected tool or subagent call')
  const path = 'event.payload'
  const item = record(value, path)
  exactKeys(
    item,
    ['schemaVersion', 'callId', 'phase', 'permissionEligibility'],
    ['parentCallId', 'name', 'input', 'output', 'durationMs'],
    path
  )
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'expected 1')
  callId(item.callId, `${path}.callId`)
  if (item.parentCallId !== undefined && item.parentCallId !== null) {
    callId(item.parentCallId, `${path}.parentCallId`)
    if (item.parentCallId === item.callId)
      fail(`${path}.parentCallId`, 'a call cannot parent itself')
  }
  literal(item.phase, runtimeCallPhases, `${path}.phase`)
  if (kind !== 'subagent.observed' && item.phase !== kind.slice('tool.'.length))
    fail(`${path}.phase`, 'does not match event kind')
  literal(
    item.permissionEligibility,
    ['unknown', 'requires_approval', 'not_required'],
    `${path}.permissionEligibility`
  )
  if (item.name !== undefined) stringValue(item.name, `${path}.name`, 1, 256)
  if (item.durationMs !== undefined) integerValue(item.durationMs, `${path}.durationMs`, 0)
  for (const key of ['input', 'output'] as const) {
    if (Object.hasOwn(item, key)) decodeData(item[key], `${path}.${key}`)
  }
  assertJsonUnicode(value, path)
  return value as RuntimeCallPayload
}
