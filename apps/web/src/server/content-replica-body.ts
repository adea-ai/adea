import type { ApiContentReplicaUpsertInput } from '@adea-ai/api-client'

import { parseContentReplicaUpsertInput } from './content-replica-input'

export const CONTENT_REPLICA_MAX_REQUEST_BYTES = Math.ceil((2 * 1024 * 1024 * 4) / 3) + 4096

export async function readContentReplicaRequest(
  request: Request
): Promise<ApiContentReplicaUpsertInput | null> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (!Number.isFinite(declaredLength) || declaredLength > CONTENT_REPLICA_MAX_REQUEST_BYTES)
    return null
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > CONTENT_REPLICA_MAX_REQUEST_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return parseContentReplicaUpsertInput(JSON.parse(new TextDecoder().decode(body)))
  } catch {
    return null
  }
}
