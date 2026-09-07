export function mergeTranscription(draft: string, transcript: string) {
  const normalized = transcript.trim()
  if (!normalized) return draft
  if (!draft) return normalized
  if (/\s$/.test(draft)) return `${draft}${normalized}`
  return `${draft} ${normalized}`
}
