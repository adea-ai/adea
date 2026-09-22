export type ContentReplicaErrorClass = 'conflict' | 'invalid' | 'unavailable' | 'retryable'

export function classifyContentReplicaError(error: unknown): ContentReplicaErrorClass {
  const message = error instanceof Error ? error.message : ''
  // These exact strings are the only domain sentinels emitted by the replica
  // service. Arbitrary infrastructure messages must stay retryable.
  if (message === 'Content replica digest conflict') return 'conflict'
  if (message === 'Content replica unavailable') return 'unavailable'
  if (message === 'Content replica metadata invalid') return 'invalid'
  return 'retryable'
}
