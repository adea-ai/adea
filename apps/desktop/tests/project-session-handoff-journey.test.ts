// Direct-session handoff host journey (#1177): the joined authoritative path
// for direct-user session -> explicit coordination handoff -> return ->
// reload, executed against the real project-session register (durable
// SQLite in a disposable temp dir, no fixtures standing in for the host).
//
// This proves what the UI fixture cannot: the actual host decoder and
// handler accept the explicit coordination operation, fence generation and
// owner version, bind the exact run, retain one session/run transcript
// identity across a process restart — without duplicating execution —
// while ordinary input-view transfer (`dev.session.transferInput`) moves
// only transient routing and records no coordination at all.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import {
  registerProjectSessionRuntime,
  type ProjectSessionRuntime,
} from '../shell/src/dev-runtime/project-session/register'
import type {
  DevCommand,
  Project,
  RuntimeSession,
  Scope,
} from '../../../../packages/types/src/dev-runtime'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const project: Project = {
  id: '00000000-0000-4000-8000-000000000020',
  scope,
  repoIds: ['00000000-0000-4000-8000-000000000030'],
  lifecycle: 'ready',
  version: 1,
}

// A direct-user session with a user-launched bound run and no prior handoff
// facts: generation 1, owner version 1, no retained coordination.
const session: RuntimeSession = {
  id: '00000000-0000-4000-8000-000000000040',
  scope,
  projectId: project.id,
  repoId: project.repoIds[0]!,
  worktreeId: '00000000-0000-4000-8000-000000000050',
  displayName: 'Direct session',
  lifecycle: 'active',
  archived: false,
  projection: 'structured',
  generation: 1,
  version: 1,
  activeHarnessRunId: '00000000-0000-4000-8000-000000000060',
}

function seedRuntime(
  dataDir: string,
  published: Array<{ event: string; kind: string }>
): ProjectSessionRuntime {
  const runtime = registerProjectSessionRuntime({
    authority: { registerCommandProvider() {} },
    dataDir,
    scope,
    publish: (event, payload) => {
      published.push({ event, kind: (payload as { kind: string }).kind })
    },
  })
  runtime.upsertProject(project)
  runtime.upsertSession(session)
  return runtime
}

function command(
  operation: DevCommand['operation'],
  body: unknown,
  resource?: DevCommand['resource']
): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: 'test-request',
    nonce: 'test-nonce',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    scope,
    capabilities: ['dev.session.manage'],
    body,
    ...(resource === undefined ? {} : { resource }),
  } as DevCommand
}

function sessionResource(generation: number): DevCommand['resource'] {
  return { kind: 'runtime_session', id: session.id, generation }
}

function coordinate(
  runtime: ProjectSessionRuntime,
  args: {
    expectedGeneration: number
    toHolder: 'lead' | 'user'
    harnessRunId?: string
    expectedOwnerVersion: number
  }
): RuntimeSession {
  const handler = runtime.providers['dev.session.transferCoordination']
  if (!handler) throw new Error('provider missing for dev.session.transferCoordination')
  return handler(
    command(
      'dev.session.transferCoordination',
      {
        runtimeSessionId: session.id,
        expectedGeneration: args.expectedGeneration,
        toHolder: args.toHolder,
        ...(args.harnessRunId !== undefined ? { harnessRunId: args.harnessRunId } : {}),
        expectedOwnerVersion: args.expectedOwnerVersion,
      },
      sessionResource(args.expectedGeneration)
    )
  ) as RuntimeSession
}

function expectCode(run: () => unknown, code: DevAuthorityError['code']) {
  try {
    run()
  } catch (error) {
    if (error instanceof DevAuthorityError) {
      expect(error.code).toBe(code)
      return
    }
    const candidate = error as { code?: unknown }
    if (candidate && typeof candidate === 'object' && candidate.code === code) return
    throw error
  }
  throw new Error(`expected DevAuthorityError ${code}`)
}

describe('direct-session handoff host journey', () => {
  test('direct-user -> handoff -> return -> reload retains one run and transcript identity', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-handoff-'))
    const published: Array<{ event: string; kind: string }> = []
    try {
      const runtime = seedRuntime(dataDir, published)
      expect('coordinationOwner' in session).toBe(false)

      // Explicit handoff: coordination binds to the exact register-bound run.
      const handedOff = coordinate(runtime, {
        expectedGeneration: 1,
        toHolder: 'lead',
        harnessRunId: session.activeHarnessRunId,
        expectedOwnerVersion: 1,
      })
      expect(handedOff.id).toBe(session.id)
      expect(handedOff.generation).toBe(2)
      expect(handedOff.version).toBe(2)
      expect(handedOff.coordinationOwner).toBe('lead')
      expect(handedOff.coordinationHarnessRunId).toBe(session.activeHarnessRunId)
      expect(handedOff.activeHarnessRunId).toBe(session.activeHarnessRunId)
      expect(handedOff.worktreeId).toBe(session.worktreeId)
      expect(handedOff.projectId).toBe(session.projectId)
      expect(handedOff.lifecycle).toBe('active')

      // Return: coordination releases back to the user and drops the binding.
      const returned = coordinate(runtime, {
        expectedGeneration: 2,
        toHolder: 'user',
        expectedOwnerVersion: 2,
      })
      expect(returned.id).toBe(session.id)
      expect(returned.generation).toBe(3)
      expect(returned.version).toBe(3)
      expect(returned.coordinationOwner).toBe('user')
      expect('coordinationHarnessRunId' in returned).toBe(false)
      expect(returned.activeHarnessRunId).toBe(session.activeHarnessRunId)
      expect(returned.worktreeId).toBe(session.worktreeId)
      expect(returned.projectId).toBe(session.projectId)

      // Both coordination transfers published; nothing duplicated.
      const transfers = published.filter(
        (entry) =>
          entry.event === 'dev.session.updated' && entry.kind === 'session.coordination_changed'
      )
      expect(transfers).toHaveLength(2)
      const listed = (
        runtime.providers['dev.session.list']!(command('dev.session.list', {})) as {
          items: RuntimeSession[]
        }
      ).items
      expect(listed.map((entry) => entry.id)).toEqual([session.id])

      // Reload persistence: a brand-new register over the same directory
      // retains the journey — one session, advanced generation and version,
      // user-held coordination, same bound run and location.
      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const reloaded = restarted.providers['dev.session.get']!(
        command('dev.session.get', { runtimeSessionId: session.id })
      ) as RuntimeSession
      expect(reloaded.id).toBe(session.id)
      expect(reloaded.generation).toBe(3)
      expect(reloaded.version).toBe(3)
      expect(reloaded.coordinationOwner).toBe('user')
      expect('coordinationHarnessRunId' in reloaded).toBe(false)
      expect(reloaded.activeHarnessRunId).toBe(session.activeHarnessRunId)
      expect(reloaded.worktreeId).toBe(session.worktreeId)
      expect(reloaded.projectId).toBe(session.projectId)
      expect(reloaded.archived).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('ordinary input-view transfer records no coordination', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-handoff-'))
    const published: Array<{ event: string; kind: string }> = []
    try {
      const runtime = seedRuntime(dataDir, published)
      const handler = runtime.providers['dev.session.transferInput']
      if (!handler) throw new Error('provider missing for dev.session.transferInput')
      const moved = handler(
        command(
          'dev.session.transferInput',
          {
            runtimeSessionId: session.id,
            expectedGeneration: 1,
            fromView: 'chat',
            toView: 'dev',
            expectedOwnerVersion: 1,
          },
          sessionResource(1)
        )
      ) as RuntimeSession
      // View routing moved (generation bumped) but no coordination was
      // recorded: a plain chat<->Dev View switch never hands off.
      expect(moved.generation).toBe(2)
      expect('coordinationOwner' in moved).toBe(false)
      expect(
        published.filter((entry) => entry.kind === 'session.coordination_changed')
      ).toHaveLength(0)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('coordination fencing refuses stale, foreign, and unbound handoffs', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-handoff-'))
    const published: Array<{ event: string; kind: string }> = []
    try {
      const runtime = seedRuntime(dataDir, published)
      // A handoff without naming the bound run binds nothing.
      expectCode(
        () =>
          coordinate(runtime, {
            expectedGeneration: 1,
            toHolder: 'lead',
            expectedOwnerVersion: 1,
          }),
        'invalid_state'
      )
      // A handoff naming any other run is refused, not misbound.
      expectCode(
        () =>
          coordinate(runtime, {
            expectedGeneration: 1,
            toHolder: 'lead',
            harnessRunId: '00000000-0000-4000-8000-000000000099',
            expectedOwnerVersion: 1,
          }),
        'invalid_state'
      )
      // A return with nothing lead-held to return is refused.
      expectCode(
        () =>
          coordinate(runtime, { expectedGeneration: 1, toHolder: 'user', expectedOwnerVersion: 1 }),
        'invalid_state'
      )
      // Stale generation and owner version fail closed.
      expectCode(
        () =>
          coordinate(runtime, {
            expectedGeneration: 999,
            toHolder: 'lead',
            harnessRunId: session.activeHarnessRunId,
            expectedOwnerVersion: 1,
          }),
        'stale_generation'
      )
      expectCode(
        () =>
          coordinate(runtime, {
            expectedGeneration: 1,
            toHolder: 'lead',
            harnessRunId: session.activeHarnessRunId,
            expectedOwnerVersion: 999,
          }),
        'stale_version'
      )
      // Nothing moved: the record still stands at its genesis.
      const current = runtime.providers['dev.session.get']!(
        command('dev.session.get', { runtimeSessionId: session.id })
      ) as RuntimeSession
      expect(current.generation).toBe(1)
      expect(current.version).toBe(1)
      expect('coordinationOwner' in current).toBe(false)
      expect(
        published.filter((entry) => entry.kind === 'session.coordination_changed')
      ).toHaveLength(0)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a foreign coordination binding fails closed as corrupt on reload', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-handoff-'))
    const published: Array<{ event: string; kind: string }> = []
    try {
      const runtime = seedRuntime(dataDir, published)
      runtime.upsertSession({
        ...session,
        version: session.version + 1,
        coordinationOwner: 'nobody' as never,
      })
      expect(() =>
        registerProjectSessionRuntime({
          authority: { registerCommandProvider() {} },
          dataDir,
          scope,
        })
      ).toThrow(/failed to decode/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
