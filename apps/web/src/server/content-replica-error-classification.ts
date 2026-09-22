export type ContentReplicaErrorClass = 'conflict' | 'invalid' | 'unavailable' | 'retryable'

export function classifyContentReplicaError(error: unknown): ContentReplicaErrorClass {
  const message = error instanceof Error ? error.message : ''
  if (message.endsWith('conflict')) return 'conflict'
  if (message.endsWith('unavailable')) return 'unavailable'
  if (message === 'Content replica metadata invalid') return 'invalid'
  return 'retryable'
}
