import { fail, record } from './dev-runtime-validation-internal'

// A high surrogate not followed by a low one, or a low surrogate not preceded
// by a high one. Code-unit semantics (no `u` flag) are required here.
const illFormed = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** UTF-8 must preserve the producer's string, never replace a lone surrogate. */
export function assertWellFormedUnicode(value: string, path: string): void {
  if (illFormed.test(value)) fail(path, 'ill-formed Unicode string')
}

/** Called after the contract's JSON bounds; includes envelope values and map keys. */
export function assertJsonUnicode(value: unknown, path = 'event', depth = 0): void {
  if (depth > 32) fail(path, 'maximum nesting depth exceeded')
  if (typeof value === 'string') assertWellFormedUnicode(value, path)
  else if (Array.isArray(value)) {
    for (const [index, entry] of value.entries())
      assertJsonUnicode(entry, `${path}[${index}]`, depth + 1)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(record(value, path))) {
      assertWellFormedUnicode(key, `${path} key`)
      assertJsonUnicode(entry, `${path}.${key}`, depth + 1)
    }
  }
}
