import { fail, record } from './dev-runtime-validation-internal'

/** UTF-8 must preserve the producer's string, never replace a lone surrogate. */
export function assertWellFormedUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(path, 'ill-formed Unicode string')
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail(path, 'ill-formed Unicode string')
  }
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
