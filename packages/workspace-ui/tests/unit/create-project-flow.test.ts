import { describe, expect, test } from 'bun:test'

import { createUnavailableDevRuntimeService } from '@adea-ai/dev-view/platform'
import type { DevCommand, DevReply, DevRuntimeService, Scope } from '@adea-ai/types/dev-runtime'

import {
  devProjectFlow,
  resolveCreateProjectSurface,
  type DevProjectFlow,
} from '../../src/create-project-flow'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

/**
 * A ready runtime whose `preferenceScope` answers exactly the scope passed in
 * (`undefined` models a runtime that never bound one) and whose `execute`
 * records what it was asked to run.
 */
function readyRuntime(runtimeScope: Scope | undefined): {
  readonly commands: DevCommand[]
  readonly runtime: DevRuntimeService
} {
  const commands: DevCommand[] = []
  const runtime: DevRuntimeService = {
    state: () => ({ status: 'ready' }),
    preferenceScope: () => runtimeScope,
    capabilitySnapshot: async () => {
      throw new Error('not used by the flow')
    },
    execute: async (command: DevCommand): Promise<DevReply> => {
      commands.push(command)
      throw new Error('execute is delegated, not called by the seam')
    },
  }
  return { commands, runtime }
}

const host = {
  renderDialog: () => undefined,
  knownProjectNames: ['Existing Project'],
  onCreateProject: async (name: string) => `project-id-for-${name}`,
}

describe('resolveCreateProjectSurface', () => {
  test('a host without an injected flow keeps the basic create dialog', () => {
    expect(resolveCreateProjectSurface(undefined)).toBe('basic')
  })

  test('a host that injects the Dev flow opens the detailed dialog', () => {
    const { runtime } = readyRuntime(scope)
    const flow = devProjectFlow({ runtime, ...host })
    expect(flow).toBeDefined()
    expect(resolveCreateProjectSurface(flow)).toBe('detailed')
  })
})

describe('devProjectFlow', () => {
  test('a ready, scoped runtime yields the flow with the host callbacks wired', () => {
    const { runtime } = readyRuntime(scope)
    const flow = devProjectFlow({ runtime, ...host })
    expect(flow?.scope).toEqual(scope)
    expect(flow?.knownProjectNames).toEqual(['Existing Project'])
    expect(flow?.onCreateProject('Next')).resolves.toBe('project-id-for-Next')
    expect(flow?.pickFolder).toBeUndefined()
  })

  test('the flow delegates repository commands to the host runtime', async () => {
    const { commands, runtime } = readyRuntime(scope)
    const flow = devProjectFlow({ runtime, ...host })
    expect(flow).toBeDefined()
    const command = {
      operation: 'dev.project.bookmarks',
      requestId: 'request-1',
      scope,
      body: {},
    } as unknown as DevCommand
    await expect(flow!.execute(command)).rejects.toThrow('delegated')
    expect(commands).toEqual([command])
  })

  test('an unavailable runtime yields no flow, so the basic dialog stays', () => {
    const flow = devProjectFlow({
      runtime: createUnavailableDevRuntimeService(),
      ...host,
    })
    expect(flow).toBeUndefined()
    expect(resolveCreateProjectSurface(flow)).toBe('basic')
  })

  test('a ready runtime without a bound scope yields no flow', () => {
    const { runtime } = readyRuntime(undefined)
    expect(devProjectFlow({ runtime, ...host })).toBeUndefined()
  })

  test('the host folder picker is carried only when provided', async () => {
    const { runtime } = readyRuntime(scope)
    const withPicker: DevProjectFlow | undefined = devProjectFlow({
      runtime,
      ...host,
      pickFolder: async () => '/absolute/path/to/project',
    })
    expect(withPicker?.pickFolder).toBeDefined()
    expect(await withPicker?.pickFolder?.()).toBe('/absolute/path/to/project')
  })
})
