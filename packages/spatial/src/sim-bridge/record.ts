/** Strict structural readers shared by the bridge validators. No coercion, no extra keys. */

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && !hasSymbolKeys(value)
}

function hasSymbolKeys(value: object): boolean {
  return Object.getOwnPropertySymbols(value).length > 0
}

/**
 * The record when it is plain and carries exactly the allowed keys: every `required` key is
 * present and no key outside `required` and `optional` exists. Accessor properties are refused so
 * a getter can never run during validation.
 */
export function strictRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null
  // Refuse a wide object before allocating a descriptor for each of its keys.
  if (Object.getOwnPropertyNames(value).length > required.length + optional.length) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!('value' in descriptor)) return null
    if (!required.includes(key) && !optional.includes(key)) return null
  }
  for (const key of required) if (!keys.includes(key)) return null
  return value
}

/**
 * An own data property of a plain record, or undefined. Used to branch on a discriminant before
 * the strict reader runs, without ever invoking a getter or walking the prototype chain.
 */
export function ownDataValue(value: unknown, key: string): unknown {
  if (!isPlainRecord(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

export function boundedString(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null
}

/** An ISO-8601 UTC instant as produced by `Date.prototype.toISOString`. */
export function isoInstant(value: unknown): number | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)
  )
    return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}
