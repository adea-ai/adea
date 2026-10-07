import { parseRuntimeNodePullRequest } from '@adea-ai/types/runtime-node-delivery'

/** A pull carries no content. Bound actual streamed bytes, not just Content-Length. */
export async function readRuntimeNodePullInput(request: Request) {
  const limit = 1024
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
    return parseRuntimeNodePullRequest(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)))
    )
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}
