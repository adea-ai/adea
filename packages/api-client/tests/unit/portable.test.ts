import { describe, expect, test } from 'bun:test'

import { ApiClientError, createApiClient } from '../../src'

const WORKSPACE_ID = '8f3c1a52-0000-4000-8000-000000000001'

function clientFor(respond: (url: string, init: RequestInit) => Response) {
  const calls: { init: RequestInit; url: string }[] = []
  const client = createApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      calls.push({ init: init ?? {}, url: String(input) })
      return respond(String(input), init ?? {})
    },
  })
  return { calls, client }
}

describe('exportWorkspace', () => {
  test('returns the attachment text with its server file name', async () => {
    const body = JSON.stringify({ format: 'adea.portable-workspace-export' })
    const { calls, client } = clientFor(
      () =>
        new Response(body, {
          headers: {
            'content-disposition': `attachment; filename="workspace-${WORKSPACE_ID}.portable.json"`,
          },
        })
    )
    const file = await client.exportWorkspace(WORKSPACE_ID)
    expect(calls[0]?.url).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/portable-export`)
    expect(file).toEqual({
      bytes: new TextEncoder().encode(body).byteLength,
      fileName: `workspace-${WORKSPACE_ID}.portable.json`,
      text: body,
    })
  })

  test('falls back to a derived file name when the header is missing', async () => {
    const { client } = clientFor(() => new Response('{}'))
    expect((await client.exportWorkspace(WORKSPACE_ID)).fileName).toBe(
      `workspace-${WORKSPACE_ID}.portable.json`
    )
  })

  test('reads the portable `error` name and the standard `code` name', async () => {
    const tooLarge = clientFor(() =>
      Response.json({ error: 'too_large', maxBytes: 8_388_608 }, { status: 413 })
    )
    await expect(tooLarge.client.exportWorkspace(WORKSPACE_ID)).rejects.toMatchObject({
      code: 'too_large',
      status: 413,
    })
    const unavailable = clientFor(() =>
      Response.json(
        { code: 'workspace_unavailable', message: 'Workspace unavailable' },
        { status: 404 }
      )
    )
    const failure = await unavailable.client.exportWorkspace(WORKSPACE_ID).catch((error) => error)
    expect(failure).toBeInstanceOf(ApiClientError)
    expect(failure).toMatchObject({ code: 'workspace_unavailable', status: 404 })
  })
})

describe('importWorkspace', () => {
  test('posts the file text as JSON and returns the import result', async () => {
    const result = {
      contentDigest: 'abc',
      counts: { agents: 1 },
      deferred: [],
      workspaceId: WORKSPACE_ID,
    }
    const { calls, client } = clientFor(() => Response.json(result, { status: 201 }))
    await expect(client.importWorkspace('{"format":"x"}')).resolves.toEqual(result)
    expect(calls[0]?.url).toBe('/api/v1/portable-imports')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.body).toBe('{"format":"x"}')
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json')
  })

  test('surfaces each named refusal as its code', async () => {
    for (const [name, status] of [
      ['invalid_document', 422],
      ['digest_mismatch', 422],
      ['unresolved_users', 422],
      ['importer_unavailable', 403],
      ['target_exists', 409],
      ['too_large', 413],
      ['verification_failed', 500],
    ] as const) {
      const { client } = clientFor(() => Response.json({ error: name }, { status }))
      await expect(client.importWorkspace('{}')).rejects.toMatchObject({ code: name, status })
    }
  })

  test('keeps the status text for a body that is not JSON', async () => {
    const { client } = clientFor(
      () => new Response('<html>', { status: 502, statusText: 'Bad Gateway' })
    )
    await expect(client.importWorkspace('{}')).rejects.toMatchObject({
      message: 'Bad Gateway',
      status: 502,
    })
  })
})
