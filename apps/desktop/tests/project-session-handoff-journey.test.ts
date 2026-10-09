// Direct-session input routing (#1177): the joined authoritative path for
// ordinary chat<->Dev View view transfer, executed against the real
// project-session register (durable SQLite in a disposable temp dir, no
// fixtures standing in for the host).
//
// This proves what the UI fixture cannot: the actual host decoder and
// handler move only transient input-view routing, fence generation and
// owner version, and retain one session/run transcript identity across a
// process restart — without duplicating execution — while recording no
// coordination of any kind. Lead coordination lives exclusively with
// lead-turn admission and its canonical records; the dev register neither
// stores nor consults it.
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

// A direct-user session with a user-launched bound run: generation 1,
// owner version 1, no coordination fields whatsoever.
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

function transferInput(
  runtime: ProjectSessionRuntime,
  args: {
    expectedGeneration: number
    fromView: 'chat' | 'dev'
    toView: 'chat' | 'dev'
    expectedOwnerVersion: number
  }
): RuntimeSession {
  const handler = runtime.providers['dev.session.transferInput']
  if (!handler) throw new Error('provider missing for dev.session.transferInput')
  return handler(
    command(
      'dev.session.transferInput',
      {
        runtimeSessionId: session.id,
        expectedGeneration: args.expectedGeneration,
        fromView: args.fromView,
        toView: args.toView,
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

describe('direct-session input routing', () => {
  test('view transfer moves routing only and retains one run across reload', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-routing-'))
    const published: Array<{ event: string; kind: string }> = []
    try {
      const runtime = seedRuntime(dataDir, published)
      expect('coordinationOwner' in session).toBe(false)
      expect('coordinationHarnessRunId' in session).toBe(false)

      const moved = transferInput(runtime, {
        expectedGeneration: 1,
        fromView: 'chat',
        toView: 'dev',
        expectedOwnerVersion: 1,
      })
      expect(moved.id).toBe(session.id)
      expect(moved.generation).toBe(2)
      expect(moved.version).toBe(2)
      expect(moved.activeHarnessRunId).toBe(session.activeHarnessRunId)
      expect(moved.worktreeId).toBe(session.worktreeId)
      expect(moved.projectId).toBe(session.projectId)
      // View routing moved, but nothing was coordinated: no retained
      // coordination keys exist on the reply, and no coordination event
      // was published — only the input transfer itself.
      expect('coordinationOwner' in moved).toBe(false)
      expect('coordinationHarnessRunId' in moved).toBe(false)
      const transfers = published.filter(
        (entry) =>
          entry.event === 'dev.session.updated' && entry.kind === 'session.input_transferred'
      )
      expect(transfers).toHaveLength(1)
      expect(
        published.filter((entry) => entry.kind === 'session.coordination_changed')
      ).toHaveLength(0)

      const listed = (
        runtime.providers['dev.session.list']!(command('dev.session.list', {})) as {
          items: RuntimeSession[]
        }
      ).items
      expect(listed.map((entry) => entry.id)).toEqual([session.id])

      // Reload persistence: a brand-new register over the same directory
      // retains the session — same run and location, advanced generation
      // and version, still no coordination residue.
      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const reloaded = restarted.providers['dev.session.get']!(
        command('dev.session.get', { runtimeSessionId: session.id })
      ) as RuntimeSession
      expect(reloaded.id).toBe(session.id)
      expect(reloaded.generation).toBe(2)
      expect(reloaded.version).toBe(2)
      expect(reloaded.activeHarnessRunId).toBe(session.activeHarnessRunId)
      expect(reloaded.worktreeId).toBe(session.worktreeId)
      expect(reloaded.projectId).toBe(session.projectId)
      expect(reloaded.archived).toBe(false)
      expect('coordinationOwner' in reloaded).toBe(false)
      expect('coordinationHarnessRunId' in reloaded).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('stale generations, versions, and foreign bindings are fenced, not applied', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-routing-'))
    const published: Array<{ event: string; kind: string }> = []
    try {
      const runtime = seedRuntime(dataDir, published)
      const transfer = {
        runtimeSessionId: session.id,
        fromView: 'chat',
        toView: 'dev',
        expectedOwnerVersion: 1,
      } as const
      expectCode(
        () => transferInput(runtime, { ...transfer, expectedGeneration: 999 }),
        'stale_generation'
      )
      expectCode(
        () =>
          transferInput(runtime, {
            ...transfer,
            expectedGeneration: 1,
            expectedOwnerVersion: 999,
          }),
        'stale_version'
      )
      const handler = runtime.providers['dev.session.transferInput']
      if (!handler) throw new Error('provider missing for dev.session.transferInput')
      expectCode(
        () =>
          handler(
            command(
              'dev.session.transferInput',
              { ...transfer, expectedGeneration: 1 },
              { kind: 'runtime_session', id: 'other-session', generation: 1 }
            )
          ),
        'identity_mismatch'
      )
      // Nothing moved: the record still stands at its genesis.
      const current = runtime.providers['dev.session.get']!(
        command('dev.session.get', { runtimeSessionId: session.id })
      ) as RuntimeSession
      expect(current.generation).toBe(1)
      expect(current.version).toBe(1)
      expect(published.filter((entry) => entry.kind === 'session.input_transferred')).toHaveLength(
        0
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
