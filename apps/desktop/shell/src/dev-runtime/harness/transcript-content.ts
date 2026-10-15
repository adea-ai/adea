import type { RuntimeEvent } from '../../../../../../packages/types/src/dev-runtime'

function filteredTranscriptText(text: string): string {
  const filtered = text
    .toWellFormed()
    .replace(
      /-----BEGIN [^-\r\n]{1,64}-+[\s\S]*?(?:-----END [^-\r\n]{1,64}-+|$)/g,
      '[secret redacted]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [secret redacted]')
    .replace(/\b(?:sk|pk|api|token|secret)[-_][A-Za-z0-9._-]{8,}/gi, '[secret redacted]')
    .replace(
      /\b(?:password|passwd|api[_-]?key|token|secret|authorization)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      '[secret redacted]'
    )
    .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/gi, '$1[secret redacted]@')
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s`"']+/g, '[private path]')
  let safe = ''
  for (const char of filtered) {
    const code = char.codePointAt(0)!
    if ((code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0x7f) continue
    safe += char
  }
  return safe
}

/** Bounded explicit projection, never the workspace-memory delivery preamble. */
export function transcriptPromptText(text: string): { text: string; textTruncated: boolean } {
  // Filter before truncating so a secret crossing the display cut cannot leak.
  const filtered = filteredTranscriptText(text)
  let bounded = ''
  let bytes = 0
  const encoder = new TextEncoder()
  for (const char of filtered) {
    const size = encoder.encode(char).byteLength
    if (bytes + size > 16_384) return { text: bounded, textTruncated: true }
    bounded += char
    bytes += size
  }
  return { text: bounded, textTruncated: false }
}

/** Defense in depth at the serialized transcript boundary, including legacy records. */
export function transcriptEvent(event: RuntimeEvent): RuntimeEvent {
  if (event.classification === 'credential' || event.classification === 'restricted_local')
    return { ...event, payload: {} }
  const filter = (value: unknown, depth = 0): unknown => {
    if (depth > 32) return null
    if (typeof value === 'string') return filteredTranscriptText(value)
    if (Array.isArray(value)) return value.map((entry) => filter(entry, depth + 1))
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          /^(?:password|passwd|api[_-]?key|token|secret|authorization|cookie|credentials?)$/i.test(
            key
          )
            ? '[secret redacted]'
            : filter(entry, depth + 1),
        ])
      )
    return value
  }
  return { ...event, payload: filter(event.payload) }
}
