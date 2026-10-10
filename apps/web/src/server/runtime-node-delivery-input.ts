import { parseRuntimeNodePullRequest } from '@adea-ai/types/runtime-node-delivery'

/** A pull carries no content. Bound actual streamed bytes, not just Content-Length. */
/** Reads a JSON body of at most `limit` bytes, bounding streamed bytes, not Content-Length. */
export async function readBoundedJsonBody(
  request: Request,
  limit: number
): Promise<unknown | null> {
  const length = Number(request.headers.get('content-length') ?? '0')
  if (!request.body || !Number.isFinite(length) || length < 0 || length > limit) return null
  const reader = request.body.getReader()
  const bytes = new Uint8Array(limit)
  let count = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (count + chunk.value.byteLength > limit) {
        await reader.cancel()
        return null
      }
      bytes.set(chunk.value, count)
      count += chunk.value.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)))
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}

/** A pull carries no content. Bound actual streamed bytes, not just Content-Length. */
export async function readRuntimeNodePullInput(request: Request) {
  const value = await readBoundedJsonBody(request, 1024)
  return value === null ? null : parseRuntimeNodePullRequest(value)
}
