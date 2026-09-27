import type { TranscriptRow } from '@adea-ai/ui/components/conversation/transcript-composition'
import type { ChatTranscriptItem } from './presentation'

/** Opaque runtime payloads establish no safe call, answer, or folding semantics. */
export function runtimeTranscriptRows(
  items: readonly ChatTranscriptItem[]
): readonly TranscriptRow<ChatTranscriptItem>[] {
  return items.map((item) => ({ id: item.id, value: item, alwaysVisible: true }))
}
