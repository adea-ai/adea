/*
 * Check log presentation. Actions prefixes every line with an ISO timestamp;
 * the viewer strips it. The Failures filter keeps lines that read as a
 * failure plus a few lines of context after each, numbered by their position
 * in the full log so both views agree.
 */

export type LogLine = Readonly<{ number: number; text: string; failure: boolean }>

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/
const FAILURE =
  /(##\[error\]|\berror\b|\bfail(?:ed|ure|s)?\b|\bFAIL\b|✗|✖|×|\bpanic\b|\bexception\b|Traceback)/i

export function logLines(text: string): readonly LogLine[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line, index) => {
    const clean = line.replace(TIMESTAMP, '').replace(/^##\[(?:group|endgroup)\]/, '')
    return { number: index + 1, text: clean, failure: FAILURE.test(clean) }
  })
}

export function failureLines(lines: readonly LogLine[], context = 4): readonly LogLine[] {
  const keep = new Set<number>()
  lines.forEach((line, index) => {
    if (!line.failure) return
    for (let offset = 0; offset <= context && index + offset < lines.length; offset += 1)
      keep.add(index + offset)
  })
  return lines.filter((_, index) => keep.has(index))
}
