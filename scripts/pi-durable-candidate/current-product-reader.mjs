// TEST ONLY. The caller supplies identifiers; the closure owns all product evidence.
import { timingSafeEqual } from 'node:crypto'

export function createCurrentProductReaderHandler({ credential, readCurrent }) {
  if (!credential) throw new Error('Synthetic reader credential required')
  const expected = Buffer.from(`Bearer ${credential}`)
  return async (request) => {
    const supplied = Buffer.from(request.headers.get('authorization') ?? '')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return new Response(null, { status: 401 })
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/current-product')
      return new Response(null, { status: 404 })
    try {
      // Stream-bound parsing also limits requests without a Content-Length header.
      const reader = request.body?.getReader()
      if (!reader) return new Response(null, { status: 400 })
      const chunks = []
      let size = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.length
          if (size > 4096) {
            await reader.cancel()
            return new Response(null, { status: 413 })
          }
          chunks.push(Buffer.from(value))
        }
      } finally {
        reader.releaseLock()
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (
        !input ||
        Array.isArray(input) ||
        Object.keys(input).toSorted().join(',') !== 'intentId,principalId,workspaceId' ||
        Object.values(input).some(
          (value) => typeof value !== 'string' || !value || value.length > 256
        )
      )
        return new Response(null, { status: 400 })
      const evidence = await readCurrent(input)
      return evidence ? Response.json(evidence) : new Response(null, { status: 404 })
    } catch {
      return new Response(null, { status: 404 })
    }
  }
}
