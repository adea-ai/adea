import { describe, expect, test } from 'bun:test'

import { AgentHqApiClient, TaskSubmissionApiClient } from '../../src'

describe('Task API client', () => {
  test('keeps encrypted submission admission distinct from lifecycle commands', async () => {
    const requests: Request[] = []
    const response = { submission: { id: 'intent', state: 'queued_for_node' } }
    const client = new TaskSubmissionApiClient({
      baseUrl: 'https://adea.invalid/api',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json(response)
      },
    })
    const input = {
      runtimeNodeId: 'node',
      queueWhenOffline: true,
      profile: { id: 'profile', version: 'pin', revision: 0 },
      envelope: { ciphertext: 'opaque' },
    }
    const command = {
      idempotencyKey: 'stable-key',
      requestId: crypto.randomUUID(),
      expectedVersion: 3,
    }
    expect(await client.enqueueTaskSubmission('workspace/1', 'task/1', input, command)).toEqual(
      response
    )
    expect(await client.getTaskSubmission('workspace/1', 'task/1')).toEqual(response)
    expect(requests.map((request) => request.url)).toEqual(
      Array(2).fill(
        'https://adea.invalid/api/v1/workspaces/workspace%2F1/tasks/task%2F1/submission'
      )
    )
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.headers.get('idempotency-key')).toBe(command.idempotencyKey)
    expect(requests[0]!.headers.get('x-request-id')).toBe(command.requestId)
    expect(requests[0]!.headers.get('if-match')).toBe('3')
    expect(await requests[0]!.json()).toEqual(input)
    expect(requests[1]!.method).toBe('GET')
  })
  test('sends idempotency and correlation metadata for create and versioned mutations', async () => {
    const requests: Request[] = []
    const client = new AgentHqApiClient({
      baseUrl: 'https://agent-hq.test/api',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({ task: { id: 'task-1' } })
      },
    })
    await client.createTask(
      'workspace/1',
      { objective: 'Ship it', title: 'Task' },
      { correlationId: 'corr-1', idempotencyKey: 'create-1', requestId: crypto.randomUUID() }
    )
    await client.queueTask('workspace/1', 'task/1', {
      expectedVersion: 1,
      idempotencyKey: 'queue-1',
      requestId: crypto.randomUUID(),
    })

    expect(requests[0]?.url).toBe('https://agent-hq.test/api/v1/workspaces/workspace%2F1/tasks')
    expect(requests[0]?.headers.get('idempotency-key')).toBe('create-1')
    expect(requests[0]?.headers.get('x-correlation-id')).toBe('corr-1')
    expect(requests[1]?.url).toBe(
      'https://agent-hq.test/api/v1/workspaces/workspace%2F1/tasks/task%2F1/queue'
    )
    expect(requests[1]?.headers.get('if-match')).toBe('1')
  })

  test('exposes all Task context mutation endpoints', async () => {
    const paths: string[] = []
    const client = new AgentHqApiClient({
      baseUrl: '/api',
      fetchImpl: async (input) => {
        paths.push(String(input))
        return Response.json({ task: { id: 'task-1' } })
      },
    })
    const command = { expectedVersion: 1, idempotencyKey: 'key', requestId: crypto.randomUUID() }
    await client.assignTask('w', 't', 'a', command)
    await client.moveTaskToProject('w', 't', 'r', command)
    await client.setTaskDependencies('w', 't', ['d'], command)
    await client.setTaskArtifactReferences('w', 't', ['artifact:1'], command)
    await client.setTaskConversationReferences(
      'w',
      't',
      { channelId: crypto.randomUUID() },
      command
    )
    expect(paths).toEqual([
      '/api/v1/workspaces/w/tasks/t/assign',
      '/api/v1/workspaces/w/tasks/t/project',
      '/api/v1/workspaces/w/tasks/t/dependencies',
      '/api/v1/workspaces/w/tasks/t/artifacts',
      '/api/v1/workspaces/w/tasks/t/conversation',
    ])
  })
})
