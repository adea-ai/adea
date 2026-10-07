import type { TaskSubmissionInput } from '@adea-ai/db'

export const MAX_TASK_SUBMISSION_REQUEST_BYTES = Math.ceil(((1024 * 1024 + 16) * 4) / 3) + 4096

export function parseTaskSubmissionInput(value: unknown): TaskSubmissionInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (
    Object.keys(body).toSorted().join(',') !== 'envelope,profile,queueWhenOffline,runtimeNodeId' ||
    !(
      typeof body.runtimeNodeId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        body.runtimeNodeId
      )
    ) ||
    typeof body.queueWhenOffline !== 'boolean' ||
    !body.profile ||
    typeof body.profile !== 'object' ||
    Array.isArray(body.profile)
  )
    return null
  const profile = body.profile as Record<string, unknown>
  if (
    Object.keys(profile).toSorted().join(',') !== 'id,revision,version' ||
    typeof profile.id !== 'string' ||
    !/^prf_[0-9A-HJKMNP-TV-Z]{26}$/u.test(profile.id) ||
    typeof profile.version !== 'string' ||
    !/^pfv_[0-9A-HJKMNP-TV-Z]{26}$/u.test(profile.version) ||
    typeof profile.revision !== 'number' ||
    !Number.isSafeInteger(profile.revision) ||
    profile.revision < 0
  )
    return null
  return {
    runtimeNodeId: body.runtimeNodeId,
    queueWhenOffline: body.queueWhenOffline,
    profile: { id: profile.id, version: profile.version, revision: profile.revision },
    envelope: body.envelope,
  }
}

/** Bound the streamed bytes too: Content-Length is not trusted admission. */
export async function readTaskSubmissionInput(
  request: Request
): Promise<TaskSubmissionInput | null> {
  const length = Number(request.headers.get('content-length') ?? '0')
  if (
    !Number.isFinite(length) ||
    length < 0 ||
    length > MAX_TASK_SUBMISSION_REQUEST_BYTES ||
    !request.body
  )
    return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > MAX_TASK_SUBMISSION_REQUEST_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(chunk.value)
    }
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return parseTaskSubmissionInput(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    )
  } catch {
    return null
  }
}
