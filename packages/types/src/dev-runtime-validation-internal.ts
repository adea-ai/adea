import type { Scope } from './dev-runtime'

export const objectPrototype = Object.prototype
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
export const uint64Pattern = /^(?:0|[1-9]\d*)$/
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const sha256Pattern = /^[0-9a-f]{64}$/
export const gitShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export function fail(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`)
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== objectPrototype && Object.getPrototypeOf(value) !== null)
  ) {
    fail(path, 'expected object')
  }
  return value as Record<string, unknown>
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string
) {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown key')
  for (const key of required) if (!(key in value)) fail(`${path}.${key}`, 'required')
}

export function stringValue(value: unknown, path: string, min = 0, max = Number.POSITIVE_INFINITY) {
  if (typeof value !== 'string' || value.length < min || value.length > max)
    fail(path, `expected string length ${min}..${max}`)
  return value
}

export function integerValue(
  value: unknown,
  path: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER
) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    fail(path, `expected integer ${min}..${max}`)
  return value as number
}

export function finiteNumber(value: unknown, path: string, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(path, `expected finite number ${min}..${max}`)
  return value
}

export function timestamp(value: unknown, path: string) {
  const text = stringValue(value, path)
  if (!timestampPattern.test(text) || Number.isNaN(Date.parse(text)))
    fail(path, 'expected UTC timestamp')
  return text
}

export function literal(value: unknown, allowed: readonly unknown[], path: string): unknown {
  if (!allowed.includes(value)) fail(path, `expected ${allowed.map(String).join('|')}`)
  return value
}

export function decodeScope(value: unknown, path = 'scope'): Scope {
  const item = record(value, path)
  exactKeys(item, ['accountId', 'workspaceId', 'runtimeNodeId'], [], path)
  for (const key of ['accountId', 'workspaceId', 'runtimeNodeId'] as const)
    if (!uuidPattern.test(stringValue(item[key], `${path}.${key}`)))
      fail(`${path}.${key}`, 'expected lowercase UUID')
  return value as Scope
}
