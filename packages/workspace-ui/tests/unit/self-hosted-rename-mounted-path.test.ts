import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ApiRuntimeNode } from '@adea-ai/api-client'

import { hostChoiceCopy, hostChoiceHealthCopy } from '../../src/self-hosted-connection-model'
import {
  applyHostRename,
  browserHostPreferenceStorage,
  selfHostedHostOperations,
} from '../../src/self-hosted-host-operations'

const src = join(import.meta.dir, '../../src')

/** A host as the list holds it: the rename notice reads its id and its name. */
function hostNode(overrides: Partial<ApiRuntimeNode>): ApiRuntimeNode {
  return {
    id: 'host-1',
    controlPlaneRuntimeNodeRefId: 'rnr_host_1',
    kind: 'remote_host',
    displayName: 'Home server',
    health: 'healthy',
    pairingState: 'paired',
    lastProofAt: '2026-10-07T06:00:00.000Z',
    deviceOnline: { state: 'not_applicable' },
    hostReachability: {
      state: 'unknown',
      dependency: 'control_plane.runtime_connection_discovery.host_reachability',
    },
    platform: 'Linux 6.1',
    softwareVersion: '0.20.0',
    lastSeenAt: '2026-10-07T06:00:00.000Z',
    ...overrides,
  }
}

/**
 * The mounted path, not the model.
 *
 * The production mount has to hand the panel a host-actions component, or the panel renders the
 * lean rows that say the server has no rename operation. These assertions are about what the
 * mount supplies and what the mounted component does.
 */
describe('the mounted self-hosted host actions', () => {
  test('the mount connects rename and nothing else', async () => {
    const calls: [string, string][] = []
    const workspaces: string[] = []
    const client = {
      renameRuntimeNode: async (
        workspaceId: string,
        runtimeNodeId: string,
        displayName: string
      ) => {
        workspaces.push(workspaceId)
        calls.push([runtimeNodeId, displayName])
      },
    } as unknown as Parameters<typeof selfHostedHostOperations>[0]

    const operations = selfHostedHostOperations(client, 'workspace-1')
    expect(typeof operations.renameHost).toBe('function')
    // Pairing and revocation are not connected in this build, so they must be absent rather
    // than merely unused: the pane shows them as unavailable only when they are absent.
    expect(operations.openPairing).toBeUndefined()
    expect(operations.revokeHost).toBeUndefined()

    await operations.renameHost!('host-1', 'workshop box')
    expect(calls).toEqual([['host-1', 'workshop box']])
    expect(workspaces).toEqual(['workspace-1'])
  })

  test('without a client the mount connects nothing', () => {
    const operations = selfHostedHostOperations(undefined, 'workspace-1')
    expect(operations).toEqual({})
  })

  test('the mounted actions are the rename row on its own', () => {
    // The full actions component also carries revocation, so the mount must not be that one.
    const full = readFileSync(join(src, 'self-hosted-host-actions.tsx'), 'utf8')
    expect(full).toContain('Revoke execution')
    const renameOnly = readFileSync(join(src, 'self-hosted-rename-actions.tsx'), 'utf8')
    expect(renameOnly).toContain('Save name')
    expect(renameOnly).not.toContain('Revoke execution')
    expect(renameOnly).not.toContain('revokeHost')
  })

  test('the production mount supplies the rename-only actions slot', () => {
    const code = readFileSync(join(src, 'self-hosted-connections-section.tsx'), 'utf8')
    expect(code).toContain('slots={{ HostActions: selfHostedHostActionsSlot() }}')
    // The slot must be the rename-only component, not the full actions component that also
    // carries revocation.
    expect(code).toContain('selfHostedHostActionsSlot')
    const renameOnly = readFileSync(join(src, 'self-hosted-rename-actions.tsx'), 'utf8')
    expect(renameOnly).toContain('export function RenameHostActions')
  })
})

describe('the mounted rename', () => {
  test('renames, re-reads the host list, and then reports the name the list shows', async () => {
    const order: string[] = []
    await applyHostRename({
      renameHost: async (hostId, displayName) => {
        order.push(`rename:${hostId}:${displayName}`)
      },
      hostId: 'host-1',
      displayName: 'workshop box',
      refreshHosts: async () => {
        order.push('refresh')
        return [hostNode({ id: 'host-1', displayName: 'workshop box' })]
      },
      notify: (notice) => {
        order.push(`notice:${notice.tone}:${notice.title}`)
      },
    })
    // The list read decides what is true, so the refresh happens before the notice.
    expect(order).toEqual(['rename:host-1:workshop box', 'refresh', 'notice:success:Host renamed'])
  })

  test('the name the list shows is the name the notice reports', async () => {
    const notices: { tone: string; title: string; text: string }[] = []
    await applyHostRename({
      renameHost: async () => undefined,
      hostId: 'host-1',
      displayName: 'workshop box',
      refreshHosts: () => [hostNode({ id: 'host-1', displayName: 'workshop box' })],
      notify: (notice) => notices.push(notice),
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]?.tone).toBe('success')
    expect(notices[0]?.text).toContain('Now shown as workshop box.')
  })

  test('a name the list does not show is never reported as shown', async () => {
    const notices: { tone: string; title: string; text: string }[] = []
    await applyHostRename({
      renameHost: async () => undefined,
      hostId: 'host-1',
      displayName: 'workshop box',
      // A concurrent change: the list shows another name now.
      refreshHosts: () => [hostNode({ id: 'host-1', displayName: 'someone elses box' })],
      notify: (notice) => notices.push(notice),
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]?.tone).toBe('warning')
    expect(notices[0]?.text).toContain('someone elses box')
    expect(notices[0]?.text).not.toContain('Now shown as workshop box')
  })

  test('a host the list no longer shows is reported as such', async () => {
    const notices: { tone: string; title: string; text: string }[] = []
    await applyHostRename({
      renameHost: async () => undefined,
      hostId: 'host-1',
      displayName: 'workshop box',
      refreshHosts: () => [],
      notify: (notice) => notices.push(notice),
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]?.tone).toBe('warning')
    expect(notices[0]?.text).toContain('no longer shows this host')
  })

  test('a list that cannot be read again reports the request result, not a confirmed name', async () => {
    const notices: { tone: string; title: string; text: string }[] = []
    await applyHostRename({
      renameHost: async () => undefined,
      hostId: 'host-1',
      displayName: 'workshop box',
      refreshHosts: async () => {
        throw new Error('the list could not be read')
      },
      notify: (notice) => notices.push(notice),
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]?.tone).toBe('warning')
    expect(notices[0]?.title).toBe('Rename request accepted')
    expect(notices[0]?.text).toContain('not confirmed')
    expect(notices[0]?.text).not.toContain('Now shown as')
  })

  test('a refresh that hands back no list leaves the name unconfirmed', async () => {
    const notices: { tone: string; title: string; text: string }[] = []
    await applyHostRename({
      renameHost: async () => undefined,
      hostId: 'host-1',
      displayName: 'workshop box',
      refreshHosts: () => undefined,
      notify: (notice) => notices.push(notice),
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]?.title).toBe('Rename request accepted')
    expect(notices[0]?.text).not.toContain('Now shown as')
  })

  test('a rename that is not connected refuses instead of pretending', async () => {
    await expect(
      applyHostRename({
        renameHost: undefined,
        hostId: 'host-1',
        displayName: 'workshop box',
        refreshHosts: () => undefined,
        notify: () => undefined,
      })
    ).rejects.toThrow('HOST_RENAME_NOT_CONNECTED')
  })
})

describe('the local note storage', () => {
  test('a storage that cannot be acquired is no note, not a failure', () => {
    // A browser may refuse storage outright, and the accessor itself can throw.
    const original = (globalThis as { window?: unknown }).window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        get localStorage(): Storage {
          throw new Error('storage is blocked')
        },
      },
    })
    try {
      expect(browserHostPreferenceStorage()).toBeUndefined()
    } finally {
      if (original === undefined) delete (globalThis as { window?: unknown }).window
      else Object.defineProperty(globalThis, 'window', { configurable: true, value: original })
    }
  })
})

describe('the remembered host copy', () => {
  test('never claims the note routes work', () => {
    for (const chosen of [true, false]) {
      const copy = hostChoiceCopy({ chosen })
      const text = `${copy.label} ${copy.description} ${copy.action} ${copy.reason}`
      // The claims the old copy made, which no submission path can honour.
      expect(text).not.toContain('New work is directed here')
      expect(text).not.toContain('Adea never falls back to another host')
      expect(text).not.toContain('Adea never chooses between hosts for you')
      expect(text).not.toMatch(/new work/i)
      // The truth the copy has to carry instead.
      expect(text).toMatch(/does not change where work runs/i)
      expect(text).toMatch(/nothing reads that memory yet/i)
      expect(text).toMatch(/browser/i)
    }
  })

  test('a revoked or ineligible host is described without a routing claim', () => {
    const revoked = hostChoiceHealthCopy({
      allowed: false,
      blockers: ['Version compatibility: Incompatible'],
      chosen: true,
      revoked: true,
    })
    expect(revoked).toMatch(/revoked/i)
    expect(revoked).not.toMatch(/will not send it work/i)

    const ineligible = hostChoiceHealthCopy({
      allowed: false,
      blockers: ['Version compatibility: Incompatible'],
      chosen: true,
      revoked: false,
    })
    expect(ineligible).toContain('Version compatibility: Incompatible')
    expect(ineligible).not.toMatch(/new work will wait/i)

    const eligible = hostChoiceHealthCopy({
      allowed: true,
      blockers: [],
      chosen: false,
      revoked: false,
    })
    expect(eligible).toMatch(/not a clearance to run work/i)
  })
})
