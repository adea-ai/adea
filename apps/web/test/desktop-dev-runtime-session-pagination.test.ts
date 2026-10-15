import { afterEach, describe, expect, test } from 'bun:test'

import { createDesktopDevRuntimeService } from '../src/lib/desktop-dev-runtime'
import type { DesktopShell } from '../src/lib/desktop-bridge'
import type { DevCommand, DevReply, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
  workspaceId: '00000000-0000-4000-8000-000000000002',
}
const OBSERVED_AT = '2026-10-15T00:00:00.000Z'
const SESSION: RuntimeSession = {
  archived: false,
  generation: 1,
  id: '00000000-0000-4000-8000-000000000040',
  lifecycle: 'ready',
  projectId: '00000000-0000-4000-8000-000000000020',
  projection: 'structured',
  repoId: '00000000-0000-4000-8000-000000000030',
  scope: SCOPE,
  version: 1,
  worktreeId: '00000000-0000-4000-8000-000000000050',
}
const SECOND_SESSION: RuntimeSession = {
  ...SESSION,
  id: '00000000-0000-4000-8000-000000000041',
}

const originalWindow = (globalThis as { window?: unknown }).window
afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
})

function installRuntime(
  execute: (command: DevCommand) => Promise<DevReply>
): ReturnType<typeof createDesktopDevRuntimeService> {
  ;(globalThis as { window?: unknown }).window = {
    __adeaDesktop: { devExecute: execute } as unknown as DesktopShell,
  }
  return createDesktopDevRuntimeService({ scope: SCOPE })
}

function reply(command: DevCommand, value: unknown): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    value,
    observedAt: OBSERVED_AT,
  } as DevReply
}

describe('desktop runtime session projection pagination', () => {
  test('follows bounded native-session pages through the authenticated projection path', async () => {
    const commands: DevCommand[] = []
    const runtime = installRuntime(async (command) => {
      commands.push(command)
      if (command.operation === 'dev.project.list') {
        return reply(command, {
          items: [{ id: SESSION.projectId, repoIds: [] }],
          observedAt: OBSERVED_AT,
        })
      }
      const body = command.body as { cursor?: string; limit?: number }
      return reply(command, {
        items: [body.cursor === undefined ? SESSION : SECOND_SESSION],
        ...(body.cursor === undefined ? { nextCursor: SESSION.id } : {}),
        observedAt: OBSERVED_AT,
      })
    })

    const projection = await runtime.projection(SCOPE)
    expect(projection.projects[0]?.sessions.map(({ id }) => id)).toEqual([
      SESSION.id,
      SECOND_SESSION.id,
    ])
    expect(commands.map(({ operation, body }) => ({ operation, body }))).toEqual([
      { operation: 'dev.project.list', body: {} },
      { operation: 'dev.session.list', body: { limit: 500 } },
      { operation: 'dev.session.list', body: { cursor: SESSION.id, limit: 500 } },
    ])
  })

  test('fails closed on an empty continuation page instead of treating it as complete', async () => {
    const runtime = installRuntime(async (command) => {
      if (command.operation === 'dev.project.list') {
        return reply(command, {
          items: [{ id: SESSION.projectId, repoIds: [] }],
          observedAt: OBSERVED_AT,
        })
      }
      return reply(command, { items: [], nextCursor: 'opaque-next', observedAt: OBSERVED_AT })
    })

    await expect(runtime.projection(SCOPE)).rejects.toThrow(/empty page/i)
  })

  test('rejects duplicate stable identities across projection pages', async () => {
    const runtime = installRuntime(async (command) => {
      if (command.operation === 'dev.project.list') {
        return reply(command, {
          items: [{ id: SESSION.projectId, repoIds: [] }],
          observedAt: OBSERVED_AT,
        })
      }
      const body = command.body as { cursor?: string }
      return reply(command, {
        items: [SESSION],
        ...(body.cursor === undefined ? { nextCursor: SESSION.id } : {}),
        observedAt: OBSERVED_AT,
      })
    })

    await expect(runtime.projection(SCOPE)).rejects.toThrow(/duplicate ids/i)
  })
})
