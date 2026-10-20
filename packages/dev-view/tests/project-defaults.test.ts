import { describe, expect, test } from 'bun:test'
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'

import {
  readProjectDefaults,
  sameProjectDefault,
  saveProjectDefaults,
} from '../src/sidebar/project-defaults'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

type Responder = (command: DevCommand) => { value?: unknown; error?: Record<string, unknown> }

function runtime(respond: Responder) {
  const commands: DevCommand[] = []
  return {
    commands,
    execute: async (command: DevCommand): Promise<DevReply> => {
      commands.push(command)
      const { value, error } = respond(command)
      return error
        ? ({
            schemaVersion: 1,
            operation: command.operation,
            requestId: command.requestId,
            ok: false,
            error: { retryable: false, observedAt: '2026-10-20T00:00:00.000Z', ...error },
          } as DevReply)
        : ({
            schemaVersion: 1,
            operation: command.operation,
            requestId: command.requestId,
            ok: true,
            value,
          } as DevReply)
    },
  }
}

const operations = (commands: readonly DevCommand[]) => commands.map((c) => c.operation)

describe('project default harness and model', () => {
  test('a project with no stored record inherits', async () => {
    const service = runtime((command) =>
      command.operation === 'dev.harness.inventory'
        ? {
            value: {
              items: [
                {
                  id: 'codex',
                  displayName: 'Codex',
                  models: [{ id: 'm1', name: 'Model one' }],
                  eligibility: { eligible: true },
                },
                { id: 'old', displayName: 'Old', eligibility: { eligible: false } },
              ],
            },
          }
        : { value: { items: [] } }
    )
    const defaults = await readProjectDefaults(service.execute, scope, 'p1')
    expect(defaults?.current).toBeUndefined()
    // Ineligible harnesses are not offered as picks.
    expect(defaults?.harnesses.map((harness) => harness.installationId)).toEqual(['codex'])
  })

  test("reads the project's own default and ignores other projects and the root default", async () => {
    const service = runtime((command) =>
      command.operation === 'dev.harness.inventory'
        ? { value: { items: [] } }
        : {
            value: {
              items: [
                { projectId: 'other', default: true, harnessInstallationId: 'x', version: 1 },
                {
                  projectId: 'p1',
                  default: true,
                  rootDefault: true,
                  harnessInstallationId: 'y',
                  version: 2,
                },
                {
                  projectId: 'p1',
                  default: true,
                  harnessInstallationId: 'codex',
                  modelId: 'm1',
                  version: 5,
                },
              ],
            },
          }
    )
    const defaults = await readProjectDefaults(service.execute, scope, 'p1')
    expect(defaults?.current).toEqual({ installationId: 'codex', modelId: 'm1', version: 5 })
  })

  test('an unreadable runtime fails closed to undefined', async () => {
    const service = runtime(() => ({ error: { code: 'unavailable', message: 'down' } }))
    expect(await readProjectDefaults(service.execute, scope, 'p1')).toBeUndefined()
  })

  test('an untouched form writes nothing', async () => {
    const service = runtime(() => ({ value: {} }))
    const current = { installationId: 'codex', modelId: 'm1', version: 5 }
    expect(sameProjectDefault(current, { installationId: 'codex', modelId: 'm1' })).toBe(true)
    expect(sameProjectDefault(undefined, undefined)).toBe(true)
    expect(sameProjectDefault(current, undefined)).toBe(false)
    expect(
      await saveProjectDefaults(service.execute, scope, 'p1', current, {
        installationId: 'codex',
        modelId: 'm1',
      })
    ).toBeUndefined()
    expect(service.commands).toEqual([])
  })

  test('picking a harness stores one project record at the observed version', async () => {
    const service = runtime(() => ({ value: {} }))
    const failure = await saveProjectDefaults(service.execute, scope, 'p1', undefined, {
      installationId: 'codex',
      modelId: 'm1',
    })
    expect(failure).toBeUndefined()
    expect(operations(service.commands)).toEqual(['dev.harness.preferenceUpdate'])
    expect(service.commands[0]!.body).toMatchObject({
      installationId: 'codex',
      projectId: 'p1',
      expectedVersion: 0,
      patch: { default: true, modelId: 'm1' },
    })
  })

  test('returning to Inherit resets the record and sends no new default', async () => {
    const service = runtime(() => ({ value: {} }))
    const failure = await saveProjectDefaults(
      service.execute,
      scope,
      'p1',
      { installationId: 'codex', version: 3 },
      undefined
    )
    expect(failure).toBeUndefined()
    expect(operations(service.commands)).toEqual(['dev.harness.preferenceReset'])
  })

  test('clearing only the model resets first, then picks the harness again from version zero', async () => {
    const service = runtime(() => ({ value: {} }))
    await saveProjectDefaults(
      service.execute,
      scope,
      'p1',
      { installationId: 'codex', modelId: 'm1', version: 3 },
      { installationId: 'codex' }
    )
    expect(operations(service.commands)).toEqual([
      'dev.harness.preferenceReset',
      'dev.harness.preferenceUpdate',
    ])
    const update = service.commands[1]!.body as { expectedVersion: number; patch: object }
    expect(update.expectedVersion).toBe(0)
    expect(update.patch).toEqual({ default: true })
  })

  test('a stale version is retried once at the version the runtime reports', async () => {
    let attempts = 0
    const service = runtime(() => {
      attempts += 1
      return attempts === 1
        ? { error: { code: 'stale_version', currentVersion: 9, message: 'stale' } }
        : { value: {} }
    })
    const failure = await saveProjectDefaults(
      service.execute,
      scope,
      'p1',
      { installationId: 'a', version: 2 },
      { installationId: 'b' }
    )
    expect(failure).toBeUndefined()
    expect((service.commands[1]!.body as { expectedVersion: number }).expectedVersion).toBe(9)
  })

  test('a refusal comes back as a message, never a throw', async () => {
    const service = runtime(() => ({ error: { code: 'forbidden', message: 'Not allowed' } }))
    expect(
      await saveProjectDefaults(service.execute, scope, 'p1', undefined, { installationId: 'a' })
    ).toBe('Not allowed')
  })
})
