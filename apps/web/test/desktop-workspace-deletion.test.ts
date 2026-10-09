import { expect, test } from 'bun:test'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { desktopWorkspaceDeletion } from '../src/lib/desktop-workspace-deletion'
const credential = { kind: 'temporary' as const, credential: 'test-guest-credential' }
const receipt = { operationId: 'operation', workspaceId: 'workspace', state: 'prepared' }
const result = { deleted: true as const, workspaceId: 'workspace', workspaces: [] }
const input = { confirmationName: 'Work', expectedVersion: 1 }

test('retains the cloud root until local cleanup is verified, then finalizes and does not wrap twice', async () => {
  const calls: string[] = []
  const notices: unknown[] = []
  const client = {
    prepareWorkspaceDeletion: async () => {
      calls.push('cloud-prepare')
      return { cleanupPending: true }
    },
    deleteWorkspace: async () => {
      calls.push('cloud-delete')
      return result
    },
  } as unknown as AgentHqApiClient
  const deletion = desktopWorkspaceDeletion({
    credential: () => credential,
    pending: (p) => notices.push(p),
    invoke: async <T>(cmd: string) => {
      calls.push(cmd.replace('desktop_identity_workspace_cleanup_', ''))
      return (cmd.endsWith('_pending') ? [] : receipt) as T
    },
  })
  deletion.attach(client)
  deletion.attach(client)
  expect(await client.deleteWorkspace('workspace', input)).toEqual(result)
  expect(calls).toEqual(['prepare', 'cloud-prepare', 'commit', 'cloud-delete', 'commit', 'pending'])
  expect(notices.at(-1)).toEqual([])
})
test('refused preflight cannot prepare or delete cloud data', async () => {
  let deleted = false
  const client = {
    prepareWorkspaceDeletion: async () => {
      deleted = true
    },
    deleteWorkspace: async () => {
      deleted = true
      return result
    },
  } as unknown as AgentHqApiClient
  desktopWorkspaceDeletion({
    credential: () => credential,
    pending: () => {},
    invoke: async () => {
      throw new Error('workspace_cleanup_running_work')
    },
  }).attach(client)
  await expect(client.deleteWorkspace('workspace', input)).rejects.toThrow(
    'Stop running workspace sessions'
  )
  expect(deleted).toBe(false)
})
test('partial device failure keeps the cloud root; retry completes from the durable receipt', async () => {
  let fail = true
  let deleted = false
  let pending: unknown = []
  const client = {
    prepareWorkspaceDeletion: async () => ({ cleanupPending: true }),
    deleteWorkspace: async () => {
      deleted = true
      return result
    },
  } as unknown as AgentHqApiClient
  const deletion = desktopWorkspaceDeletion({
    credential: () => credential,
    pending: (p) => {
      pending = p
    },
    invoke: async <T>(cmd: string) => {
      if (cmd.endsWith('_commit')) {
        if (fail) throw new Error('disk unavailable')
        return {} as T
      }
      return (
        cmd.endsWith('_pending') ? (fail ? [{ ...receipt, state: 'failed' }] : []) : receipt
      ) as T
    },
  })
  deletion.attach(client)
  await expect(client.deleteWorkspace('workspace', input)).rejects.toThrow(
    'workspace has been kept'
  )
  expect(deleted).toBe(false)
  expect(pending).toEqual([{ ...receipt, state: 'failed' }])
  fail = false
  expect(await client.deleteWorkspace('workspace', input)).toEqual(result)
  expect(deleted).toBe(true)
  expect(pending).toEqual([])
})
test('unsupported external cleanup preserves the root and asks the shell to cancel only after cloud proof', async () => {
  const calls: string[] = []
  const client = {
    prepareWorkspaceDeletion: async () => {
      throw new Error('Control Plane purge unavailable')
    },
    deleteWorkspace: async () => {
      calls.push('delete')
      return result
    },
  } as unknown as AgentHqApiClient
  desktopWorkspaceDeletion({
    credential: () => credential,
    pending: () => {},
    invoke: async <T>(cmd: string) => {
      calls.push(cmd.replace('desktop_identity_workspace_cleanup_', ''))
      return (cmd.endsWith('_pending') ? [] : receipt) as T
    },
  }).attach(client)
  await expect(client.deleteWorkspace('workspace', input)).rejects.toThrow(
    'Control Plane purge unavailable'
  )
  expect(calls).toEqual(['prepare', 'cancel', 'pending'])
})

test('server completion refusal cancels fresh preflight without local purge or cloud finalization', async () => {
  const calls: string[] = []
  const client = {
    prepareWorkspaceDeletion: async () => {
      calls.push('cloud-prepare')
      throw new Error('cannot verify cleanup completion on the server yet')
    },
    deleteWorkspace: async () => {
      calls.push('cloud-delete')
      return result
    },
  } as unknown as AgentHqApiClient
  const deletion = desktopWorkspaceDeletion({
    credential: () => credential,
    pending: () => {},
    invoke: async <T>(cmd: string) => {
      calls.push(cmd.replace('desktop_identity_workspace_cleanup_', ''))
      return (cmd.endsWith('_pending') ? [] : receipt) as T
    },
  })
  deletion.attach(client)
  for (let retry = 0; retry < 2; retry++)
    await expect(client.deleteWorkspace('workspace', input)).rejects.toThrow(
      'cannot verify cleanup completion'
    )
  expect(calls).toEqual([
    'prepare',
    'cloud-prepare',
    'cancel',
    'pending',
    'prepare',
    'cloud-prepare',
    'cancel',
    'pending',
  ])
})

test('restart retry preserves unverified pending receipts and never asks cloud to finalize', async () => {
  const calls: string[] = []
  const pending = [{ ...receipt, state: 'prepared' }]
  let displayed: unknown
  const deletion = desktopWorkspaceDeletion({
    credential: () => credential,
    pending: (p) => {
      displayed = p
    },
    invoke: async <T>(cmd: string) => {
      calls.push(cmd.replace('desktop_identity_workspace_cleanup_', ''))
      if (cmd.endsWith('_commit')) throw new Error('workspace_cleanup_completion_unverified')
      if (cmd.endsWith('_cancel')) throw new Error('workspace_cleanup_pending')
      return pending as T
    },
  })
  for (let retry = 0; retry < 2; retry++) expect(await deletion.resume()).toEqual(pending)
  expect(displayed).toEqual(pending)
  expect(calls).toEqual([
    'pending',
    'commit',
    'cancel',
    'pending',
    'pending',
    'commit',
    'cancel',
    'pending',
  ])
})
