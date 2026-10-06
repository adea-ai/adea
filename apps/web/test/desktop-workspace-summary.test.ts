/*
 * The counts-only cross-workspace run summary client (ADR 0011,
 * `dev.summary.workspaces`): one authenticated pull that strictly decodes the
 * reply and fails closed — a refusal, a thrown transport, or a reply carrying
 * anything beyond workspace ids and counts yields `undefined`, never zeros.
 */
import { describe, expect, test } from 'bun:test'
import type { DevCommand, DevReply } from '@adea-ai/types/dev-runtime'

import { workspaceSummaries } from '../src/lib/desktop-dev-runtime'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const observedAt = '2026-10-05T12:00:00.000Z'

function serviceReplying(value: (command: DevCommand) => DevReply) {
  const commands: DevCommand[] = []
  return {
    commands,
    service: {
      execute: async (command: DevCommand) => {
        commands.push(command)
        return value(command)
      },
    },
  }
}

const ok = (command: DevCommand, value: unknown): DevReply =>
  ({
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    value,
    observedAt,
  }) as DevReply

describe('workspaceSummaries', () => {
  test('builds the registry command and returns the decoded counts', async () => {
    const summary = {
      items: [{ workspaceId: scope.workspaceId, running: 2, needsInput: 1 }],
      observedAt,
    }
    const { service, commands } = serviceReplying((command) => ok(command, summary))
    expect(await workspaceSummaries(service, scope)).toEqual(summary)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      operation: 'dev.summary.workspaces',
      scope,
      capabilities: ['dev.summary.read'],
      body: {},
    })
    expect(commands[0]?.resource).toBeUndefined()
  })

  test('fails closed on refusal, transport failure, and undecodable replies', async () => {
    const refused = serviceReplying(
      (command) =>
        ({
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: false,
          error: { code: 'capability_unavailable', retryable: true, message: 'absent' },
        }) as DevReply
    )
    expect(await workspaceSummaries(refused.service, scope)).toBeUndefined()

    const thrown = {
      execute: async () => {
        throw new Error('channel closed')
      },
    }
    expect(await workspaceSummaries(thrown, scope)).toBeUndefined()

    const leaky = serviceReplying((command) =>
      ok(command, {
        items: [{ workspaceId: scope.workspaceId, running: 1, needsInput: 0, name: 'Acme' }],
        observedAt,
      })
    )
    expect(await workspaceSummaries(leaky.service, scope)).toBeUndefined()
  })
})
