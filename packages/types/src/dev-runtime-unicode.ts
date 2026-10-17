import { fail } from './dev-runtime-validation-internal'

// A high surrogate not followed by a low one, or a low surrogate not preceded
// by a high one. Code-unit semantics (no `u` flag) are required here.
const illFormed = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** UTF-8 must preserve the producer's string, never replace a lone surrogate. */
export function assertWellFormedUnicode(value: string, path: string): void {
  if (illFormed.test(value)) fail(path, 'ill-formed Unicode string')
}
