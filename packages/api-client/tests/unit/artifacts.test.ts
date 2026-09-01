import { describe, expect, test } from 'bun:test'

import { AgentHqApiClient } from '../../src'

describe('Artifact API client', () => {
  test('uses authorized metadata routes without embedding location credentials', async () => {
    const requests: Request[] = []
    const client = new AgentHqApiClient({
      baseUrl: '/api',
      fetchImpl: async (input, init) => {
        requests.push(new Request(`https://test${input}`, init))
        return Response.json({ artifact: { id: 'artifact-1' } })
      },
    })
    await client.createArtifact('workspace/1', {
      checksumSha256: 'a'.repeat(64),
      filename: 'report.txt',
      location: { reference: 'reports/1', runtimeNodeId: 'node-1', type: 'runtime_node' },
      mediaType: 'text/plain',
      sizeBytes: 10,
      sourceArtifactRef: 'source-1',
      sourcePrincipal: { kind: 'runtime_node', runtimeNodeId: 'node-1' },
    })
    await client.setArtifactAvailability('workspace/1', 'artifact/1', 'unavailable', 1)
    await client.deleteArtifact('workspace/1', 'artifact/1', 2)

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/v1/workspaces/workspace%2F1/artifacts',
      '/api/v1/workspaces/workspace%2F1/artifacts/artifact%2F1',
      '/api/v1/workspaces/workspace%2F1/artifacts/artifact%2F1',
    ])
    expect(requests[0]?.method).toBe('POST')
    expect(requests[1]?.headers.get('if-match')).toBe('1')
    expect(requests[2]?.headers.get('if-match')).toBe('2')
  })
})
