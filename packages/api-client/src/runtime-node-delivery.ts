import type {
  RuntimeNodeCommandDelivery,
  RuntimeNodePullRequest,
} from '@adea-ai/types/runtime-node-delivery'

/** Separate transport deliberately has no user-token/cookie callbacks. */
export class RuntimeNodeDeliveryClient {
  constructor(private readonly options: Readonly<{ baseUrl: string; fetchImpl?: typeof fetch }>) {}
  async pull(
    workspaceId: string,
    runtimeNodeId: string,
    proof: RuntimeNodePullRequest,
    signal?: AbortSignal
  ): Promise<Readonly<{ command: RuntimeNodeCommandDelivery | null }>> {
    const url = `${this.options.baseUrl.replace(/\/$/u, '')}/v1/workspaces/${encodeURIComponent(workspaceId)}/runtime-nodes/${encodeURIComponent(runtimeNodeId)}/commands/pull`
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      body: JSON.stringify(proof),
      credentials: 'omit',
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Node delivery refused (${response.status})`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Node delivery response unavailable')
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        total += next.value.byteLength
        if (total > 1_450_000) {
          await reader.cancel()
          throw new Error('Node delivery response too large')
        }
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    // The host must validate scope/envelope and authorize local content before accepting work.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
      command: RuntimeNodeCommandDelivery | null
    }
  }
}
