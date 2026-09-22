import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { redactSearchText } from './conversation-search-model'

const MAX_EVENTS = 1_000
const MAX_BYTES = 1_048_576

export type TranscriptExportOptions = Readonly<{
  runtimeSessionId: string
  generation: number
  maxEvents?: number
  maxBytes?: number
}>

export type TranscriptExport = Readonly<{
  runtimeSessionId: string
  generation: number
  text: string
  exportedEvents: number
  truncated: boolean
}>

function label(event: RuntimeEvent): string {
  if (event.kind === 'turn.user_input') return 'user'
  if (event.kind === 'turn.assistant_delta' || event.kind === 'turn.assistant_message')
    return 'assistant'
  if (event.kind.startsWith('tool.')) return 'tool'
  if (event.kind.startsWith('approval.')) return 'approval'
  if (event.kind.startsWith('question.')) return 'question'
  return 'status'
}

function payloadText(event: RuntimeEvent): string {
  if (event.payload !== null && typeof event.payload === 'object') {
    const payload = event.payload as Record<string, unknown>
    for (const key of ['text', 'content', 'message', 'summary', 'name', 'title', 'reason']) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim().length > 0)
        return redactSearchText(value.trim())
    }
  }
  return event.kind
}

/** Export only the bounded canonical event window for one generation. */
export function exportTranscriptWindow(
  events: readonly RuntimeEvent[],
  options: TranscriptExportOptions
): TranscriptExport {
  const maxEvents = Math.min(Math.max(options.maxEvents ?? MAX_EVENTS, 1), MAX_EVENTS)
  const maxBytes = Math.min(Math.max(options.maxBytes ?? MAX_BYTES, 256), MAX_BYTES)
  const matching = events.filter(
    (event) =>
      event.runtimeSessionId === options.runtimeSessionId && event.generation === options.generation
  )
  const selected = matching
    .filter(
      (event) =>
        event.runtimeSessionId === options.runtimeSessionId &&
        event.generation === options.generation
    )
    .slice(0, maxEvents)
  const lines: string[] = []
  let bytes = 0
  let exportedEvents = 0
  for (const event of selected) {
    const line = `[${event.occurredAt}] ${label(event)}: ${payloadText(event)}\n`
    const lineBytes = new TextEncoder().encode(line).byteLength
    if (bytes + lineBytes > maxBytes) break
    lines.push(line)
    bytes += lineBytes
    exportedEvents += 1
  }
  return {
    runtimeSessionId: options.runtimeSessionId,
    generation: options.generation,
    text: lines.join(''),
    exportedEvents,
    truncated: exportedEvents < selected.length || selected.length < matching.length,
  }
}
