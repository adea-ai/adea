/**
 * Reads a request body into bytes, enforcing `limit` on the bytes actually streamed.
 *
 * Content-Length is only a claim. It may be absent or wrong, so it never admits a body
 * on its own. A malformed claim, or one above the limit, is refused before any byte is
 * read. Otherwise the stream is read chunk by chunk, and the first chunk that crosses
 * the limit cancels the stream, so an oversized body is never buffered whole.
 *
 * Resolves to null for a refused claim, an oversized stream, a read error, or no body.
 */
export async function readBoundedRequestBytes(
  request: Readonly<{ body: ReadableStream<Uint8Array> | null; headers: Headers }>,
  limit: number
): Promise<Uint8Array | null> {
  const claimed = request.headers.get('content-length')
  if (claimed !== null && (!/^\d+$/.test(claimed) || Number(claimed) > limit)) return null
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) {
        await reader.cancel()
        return null
      }
      chunks.push(next.value)
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
  return bytes
}
