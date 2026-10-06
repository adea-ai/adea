import { afterEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

import { desktopMemoryService } from '../src/lib/desktop-memory'

const WORKSPACE = '00000000-0000-4000-8000-00000000000a'
const ENTRY = '00000000-0000-4000-8000-0000000000e1'

type Call = { cmd: string; args?: Record<string, unknown> }

function installBridge(answer: (call: Call) => unknown): Call[] {
  const calls: Call[] = []
  ;(globalThis as { window?: unknown }).window = {
    __adeaDesktop: {
      async invoke(cmd: string, args?: Record<string, unknown>) {
        calls.push({ cmd, ...(args ? { args } : {}) })
        const value = answer({ cmd, ...(args ? { args } : {}) })
        if (value instanceof Error) throw value
        return value
      },
      async listen() {
        return () => {}
      },
    },
  }
  return calls
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('desktop memory bridge', () => {
  test('sends each operation to its trusted command with exact arguments', async () => {
    const calls = installBridge(({ cmd }) =>
      cmd === 'memory_list'
        ? { entries: [], injectionEnabled: true, unreadable: 0 }
        : cmd === 'memory_injection_save'
          ? { injectionEnabled: false }
          : cmd === 'memory_delete' || cmd === 'memory_reject_proposal'
            ? null
            : { id: ENTRY }
    )
    const ref = { workspaceId: WORKSPACE, entryId: ENTRY, expectedRevision: 2 }
    expect(await desktopMemoryService.list(WORKSPACE)).toEqual({
      entries: [],
      injectionEnabled: true,
      unreadable: 0,
    })
    await desktopMemoryService.create({ workspaceId: WORKSPACE, text: 'note' })
    await desktopMemoryService.update({ ...ref, text: 'edited' })
    await desktopMemoryService.remove(ref)
    await desktopMemoryService.acceptProposal(ref)
    await desktopMemoryService.rejectProposal(ref)
    expect(
      await desktopMemoryService.setInjectionEnabled({ workspaceId: WORKSPACE, enabled: false })
    ).toBe(false)
    expect(calls).toEqual([
      { cmd: 'memory_list', args: { workspaceId: WORKSPACE } },
      { cmd: 'memory_create', args: { workspaceId: WORKSPACE, text: 'note' } },
      { cmd: 'memory_update', args: { ...ref, text: 'edited' } },
      { cmd: 'memory_delete', args: ref },
      { cmd: 'memory_accept_proposal', args: ref },
      { cmd: 'memory_reject_proposal', args: ref },
      { cmd: 'memory_injection_save', args: { workspaceId: WORKSPACE, enabled: false } },
    ])
  })

  test('surfaces the shell refusal code unchanged for the settings model', async () => {
    installBridge(() => new Error('memory_workspace_unauthorized'))
    await expect(desktopMemoryService.list(WORKSPACE)).rejects.toThrow(
      'memory_workspace_unauthorized'
    )
  })

  test('without a desktop shell the service is unreachable, never faked', async () => {
    await expect((async () => desktopMemoryService.list(WORKSPACE))()).rejects.toThrow(
      'Adea desktop shell bridge is unavailable'
    )
  })

  test('the desktop entry wires memory; the shared settings host does not assume it', async () => {
    const entry = await readFile(
      new URL('../src/components/desktop-workspace-entry.tsx', import.meta.url),
      'utf8'
    )
    expect(entry).toContain('memory: desktopMemoryService')
    const source = await readFile(new URL('../src/lib/desktop-memory.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/ciphertext|nonce|device\.key|local-content\//)
  })
})
