/*
 * Untrusted gh JSON decoding shared by the GitHub registrar and its
 * collaboration handlers. gh output is untrusted input: every field is
 * re-proven through narrow guards, and unknown extra keys are ignored
 * (GitHub adds fields freely).
 */
export class UntrustedError extends Error {}

export function untrusted(path: string, expected: string): never {
  throw new UntrustedError(`${path}: expected ${expected}`)
}

export function obj(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) untrusted(path, 'object')
  return value as Record<string, unknown>
}

export function arr(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) untrusted(path, 'array')
  return value
}

export function str(value: unknown, path: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) untrusted(path, `string<=${max}`)
  return value
}

export function optStr(value: unknown, path: string, max = 4096): string | undefined {
  if (value === undefined || value === null) return undefined
  return str(value, path, max)
}

export function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    untrusted(path, 'non-negative integer')
  return value
}

export function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') untrusted(path, 'boolean')
  return value
}

export function literal<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  if (typeof value !== 'string') untrusted(path, 'string')
  const found = choices.find((choice) => choice === value)
  if (found === undefined) untrusted(path, `one of ${choices.join('|')}`)
  return found
}

export function gitSha(value: unknown, path: string): string {
  const text = str(value, path, 64)
  if (!/^[0-9a-f]{40}$/.test(text)) untrusted(path, 'git sha')
  return text
}

export function isoTimestamp(value: unknown, path: string): string | undefined {
  const text = optStr(value, path, 64)
  if (text === undefined) return undefined
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) untrusted(path, 'timestamp')
  return new Date(parsed).toISOString()
}

export function requiredIsoTimestamp(value: unknown, path: string): string {
  const parsed = isoTimestamp(value, path)
  if (parsed === undefined) untrusted(path, 'timestamp')
  return parsed
}
