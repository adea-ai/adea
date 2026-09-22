import { describe, expect, test } from 'bun:test'

import {
  createFirstRunController,
  createFirstRunRuntimePort,
  projectFirstRun,
  type FirstRunFacts,
} from '../src/chat/onboarding'

const ready: FirstRunFacts = {
  identity: 'signed_in',
  managedPi: { state: 'ready' },
  modelAccess: 'free-tier',
  projectReady: true,
  agentProfileReady: true,
}

describe('first-run onboarding', () => {
  test('offers guest or sign-in while showing install progress', () => {
    const state = projectFirstRun({
      ...ready,
      identity: 'choice',
      managedPi: { state: 'installing' },
    })
    expect(state.stage).toBe('identity')
    expect(state.actions.map((action) => action.kind)).toEqual(['guest', 'sign_in'])
    expect(state.installStatus).toContain('installing')
  })

  test('guest without model entitlement gates at one sign-in action', () => {
    const state = projectFirstRun({ ...ready, identity: 'guest', modelAccess: 'none' })
    expect(state.stage).toBe('model_access')
    expect(state.actions.map((action) => action.kind)).toEqual(['sign_in'])
    expect(state.message).not.toMatch(/api key|token|provider/i)
    expect(
      projectFirstRun({ ...ready, identity: 'guest', modelAccess: 'free-tier' }).actions[0]?.kind
    ).toBe('sign_in')
    const authRequired = projectFirstRun({ ...ready, identity: 'auth_required' })
    expect(authRequired.actions.map((action) => action.kind)).toEqual(['sign_in'])
  })

  test('install failures translate typed codes into one action without raw diagnostics', () => {
    const retry = projectFirstRun({
      ...ready,
      managedPi: { state: 'failed', code: 'unavailable', detail: 'secret /Users/me/path' },
    })
    expect(retry.actions.map((action) => action.kind)).toEqual(['retry_install'])
    expect(retry.message).not.toContain('/Users/me/path')

    const incompatible = projectFirstRun({
      ...ready,
      managedPi: { state: 'failed', code: 'incompatible' },
    })
    expect(incompatible.actions.map((action) => action.kind)).toEqual(['update_app'])
    expect(incompatible.message).toContain('version')

    const missing = projectFirstRun({
      ...ready,
      managedPi: { state: 'failed', code: 'capability_unavailable' },
    })
    expect(missing.actions.map((action) => action.kind)).toEqual(['update_app'])
  })

  test('does not expose harness, model, or runtime choices in the ready step', () => {
    const state = projectFirstRun(ready)
    expect(state.stage).toBe('compose')
    expect(state.actions.map((action) => action.kind)).toEqual(['start'])
    expect(JSON.stringify(state)).not.toMatch(/harness choice|model picker|runtime picker/i)
  })

  test('starts only with the canonical conversation port and keeps one retry key', async () => {
    const requests: { prompt: string; idempotencyKey: string }[] = []
    const controller = createFirstRunController({
      createConversation: async (request) => {
        requests.push(request)
        if (requests.length === 1) throw new Error('connection lost')
        return { runtimeSessionId: 'session-1' }
      },
      randomId: () => 'same-key',
    })
    await expect(controller.start('  Help me plan  ', ready)).rejects.toThrow('connection lost')
    const conversation = await controller.start('  Help me plan  ', ready)
    expect(conversation.runtimeSessionId).toBe('session-1')
    expect(requests).toEqual([
      { prompt: 'Help me plan', idempotencyKey: 'same-key' },
      { prompt: 'Help me plan', idempotencyKey: 'same-key' },
    ])
    await expect(controller.start('Different prompt', ready)).rejects.toThrow('retry')
    expect(requests).toHaveLength(2)
  })

  test('blocks launch while model access, project, or profile is unresolved', async () => {
    const controller = createFirstRunController({
      createConversation: async () => ({ runtimeSessionId: 'unexpected' }),
    })
    for (const facts of [
      { ...ready, modelAccess: 'none' as const },
      { ...ready, projectReady: false },
      { ...ready, agentProfileReady: false },
    ]) {
      await expect(controller.start('Hello', facts)).rejects.toThrow()
    }
  })

  test('uses managed-Pi commands and the canonical launch without a harness pin', async () => {
    const operations: string[] = []
    const calls: unknown[] = []
    const scope = {
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      runtimeNodeId: 'node-1',
      generation: 1,
    }
    const runtime = {
      execute: async (command: { operation: string }) => {
        operations.push(command.operation)
        return {
          ok: true,
          value:
            command.operation === 'dev.harness.preferenceReset'
              ? { items: [{ harnessInstallationId: 'managed-pi', default: true }] }
              : { state: 'ready', installationId: 'managed-pi' },
        }
      },
    }
    const model = {
      create: async (input: unknown) => {
        calls.push(input)
        return { runtimeSessionId: 'canonical-1' }
      },
    }
    const port = createFirstRunRuntimePort(runtime as never, scope as never, model as never, {
      projectId: 'project-1',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      agentProfileId: 'profile-1',
      agentProfileVersion: 1,
    })
    await port.readManagedPi()
    await port.installManagedPi()
    const resetPreferences = await port.resetToManagedDefault()
    await port.createConversation({ prompt: 'Hello', idempotencyKey: 'create-1' })
    expect(operations).toEqual([
      'dev.harness.managedPiStatus',
      'dev.harness.managedPiInstall',
      'dev.harness.preferenceReset',
    ])
    expect(resetPreferences[0]?.harnessInstallationId).toBe('managed-pi')
    expect(calls).toEqual([
      {
        projectId: 'project-1',
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        agentProfileId: 'profile-1',
        agentProfileVersion: 1,
        initialPrompt: 'Hello',
        idempotencyKey: 'create-1',
      },
    ])
  })
})
