// Direct-session handoff host journey (#1177): the joined authoritative path
// for direct-user session -> explicit handoff -> return -> reload, executed
// against the real project-session register (durable SQLite in a disposable
// temp dir, no fixtures standing in for the host).
//
// This proves what the UI fixture cannot: the actual host decoder and
// handler accept both transfer directions, fence generation and owner
// version, bump both exactly once per transfer, publish
// `session.input_transferred` for each, and retain one session/run
// transcript identity across a process restart — without duplicating
// execution or granting anything beyond input ownership.
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
// facts: generation 1, owner version 1, no transfer history.
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

function transfer(
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

describe('direct-session handoff host journey', () => {
  test('direct-user -> handoff -> return -> reload retains one run and transcript identity', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-handoff-'))
    const published: Array<{ event: string; kind: string }> = []
    try {
      const runtime = seedRuntime(dataDir, published)

      // Explicit handoff: the user hands input ownership to the dev view.
      // The real decoder accepts the direction and the handler fences it.
      const handedOff = transfer(runtime, {
        expectedGeneration: 1,
        fromView: 'chat',
        toView: 'dev',
        expectedOwnerVersion: 1,
      })
      expect(handedOff.id).toBe(session.id)
      expect(handedOff.generation).toBe(2)
      expect(handedOff.version).toBe(2)
      expect(handedOff.activeHarnessRunId).toBe(session.activeHarnessRunId)
      expect(handedOff.worktreeId).toBe(session.worktreeId)
      expect(handedOff.projectId).toBe(session.projectId)
      expect(handedOff.lifecycle).toBe('active')

      // Return: ownership moves back. Same session, same run, same location.
      const returned = transfer(runtime, {
        expectedGeneration: 2,
        fromView: 'dev',
        toView: 'chat',
        expectedOwnerVersion: 2,
      })
      expect(returned.id).toBe(session.id)
      expect(returned.generation).toBe(3)
      expect(returned.version).toBe(3)
      expect(returned.activeHarnessRunId).toBe(session.activeHarnessRunId)
      expect(returned.worktreeId).toBe(session.worktreeId)
      expect(returned.projectId).toBe(session.projectId)

      // Both directions published ownership transfer; nothing duplicated.
      const transfers = published.filter(
        (entry) =>
          entry.event === 'dev.session.updated' && entry.kind === 'session.input_transferred'
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
      // same bound run and location.
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
      expect(reloaded.activeHarnessRunId).toBe(session.activeHarnessRunId)
      expect(reloaded.worktreeId).toBe(session.worktreeId)
      expect(reloaded.projectId).toBe(session.projectId)
      expect(reloaded.archived).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('stale generations, versions, and foreign bindings are fenced, not applied', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-handoff-'))
    const published: Array<{ event: string; kind: string }> = []
    try {
      const runtime = seedRuntime(dataDir, published)
      const transferInput = {
        runtimeSessionId: session.id,
        fromView: 'chat',
        toView: 'dev',
        expectedOwnerVersion: 1,
      } as const
      expectCode(
        () => transfer(runtime, { ...transferInput, expectedGeneration: 999 }),
        'stale_generation'
      )
      expectCode(
        () =>
          transfer(runtime, {
            ...transferInput,
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
              { ...transferInput, expectedGeneration: 1 },
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
