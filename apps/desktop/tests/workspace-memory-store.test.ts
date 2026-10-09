// Workspace memory store and its trusted shell commands (ADR 0012, "Memory";
// docs/specs/local-content.md "Workspace memory"): encrypted round trip,
// workspace-bound associated data, revision checks, the proposal lifecycle,
// the injection switch, bounds, and the authorized-workspace gate on the
// `memory_*` command family.
import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCommandSurface } from '../shell/src/commands'
import { loadDeviceKey } from '../shell/src/device-key'
import {
  MEMORY_PREAMBLE_HEADER,
  MEMORY_PREAMBLE_MAX_BYTES,
  compileMemoryPreamble,
} from '../shell/src/memory/preamble'
import { MemoryStoreError, createMemoryStore } from '../shell/src/memory/store'

const WORKSPACE_A = '00000000-0000-4000-8000-00000000000a'
const WORKSPACE_B = '00000000-0000-4000-8000-00000000000b'

function withStore(
  run: (context: { dir: string; store: ReturnType<typeof createMemoryStore> }) => void
) {
  const dir = mkdtempSync(join(tmpdir(), 'adea-memory-store-'))
  const key = randomBytes(32)
  let clock = Date.parse('2026-10-01T00:00:00.000Z')
  try {
    run({
      dir,
      store: createMemoryStore({ contentDir: dir, key: () => key, now: () => (clock += 1000) }),
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof MemoryStoreError ? error.code : String(error)
  }
  return undefined
}

describe('memory store', () => {
  test('round-trips entries newest first and keeps text encrypted at rest', () => {
    withStore(({ dir, store }) => {
      const first = store.create(WORKSPACE_A, { text: '  uses bun, never npm  ' })
      const second = store.create(WORKSPACE_A, { text: 'deploys on fridays' })
      expect(first).toMatchObject({
        workspaceId: WORKSPACE_A,
        text: 'uses bun, never npm',
        source: 'user',
        status: 'active',
        revision: 1,
      })
      const snapshot = store.list(WORKSPACE_A)
      expect(snapshot.entries.map((entry) => entry.id)).toEqual([second.id, first.id])
      expect(snapshot).toMatchObject({ injectionEnabled: true, unreadable: 0 })

      const onDisk = readdirSync(join(dir, 'memory'))
        .map((name) => readFileSync(join(dir, 'memory', name), 'utf8'))
        .join('\n')
      expect(onDisk).not.toContain('uses bun')
      expect(onDisk).not.toContain('fridays')
      expect(onDisk).toContain('"contentType":"memory_entry"')
    })
  })

  test('an entry cannot be read, edited or deleted under another workspace', () => {
    withStore(({ dir, store }) => {
      const entry = store.create(WORKSPACE_A, { text: 'workspace A only' })
      expect(store.list(WORKSPACE_B).entries).toEqual([])
      expect(
        codeOf(() =>
          store.update(WORKSPACE_B, { entryId: entry.id, expectedRevision: 1, text: 'stolen' })
        )
      ).toBe('memory_not_found')
      expect(
        codeOf(() => store.remove(WORKSPACE_B, { entryId: entry.id, expectedRevision: 1 }))
      ).toBe('memory_not_found')
      expect(store.preamble(WORKSPACE_B)).toBeUndefined()

      // Re-labelling the record into workspace B does not move the text: the
      // associated data binds workspace A, so authentication fails and the
      // record is reported as unreadable, never shown or injected.
      const file = join(dir, 'memory', `${entry.id}.json`)
      const record = JSON.parse(readFileSync(file, 'utf8'))
      writeFileSync(file, JSON.stringify({ ...record, workspaceId: WORKSPACE_B }))
      expect(store.list(WORKSPACE_B)).toMatchObject({ entries: [], unreadable: 1 })
      expect(store.preamble(WORKSPACE_B)).toBeUndefined()
      expect(store.list(WORKSPACE_A).entries).toEqual([])
    })
  })

  test('updates and deletes are revision checked', () => {
    withStore(({ store }) => {
      const entry = store.create(WORKSPACE_A, { text: 'v1' })
      const updated = store.update(WORKSPACE_A, {
        entryId: entry.id,
        expectedRevision: 1,
        text: 'v2',
      })
      expect(updated).toMatchObject({ text: 'v2', revision: 2 })
      expect(updated.updatedAt > entry.updatedAt).toBe(true)
      expect(
        codeOf(() =>
          store.update(WORKSPACE_A, { entryId: entry.id, expectedRevision: 1, text: 'v3' })
        )
      ).toBe('memory_stale_revision')
      expect(
        codeOf(() => store.remove(WORKSPACE_A, { entryId: entry.id, expectedRevision: 1 }))
      ).toBe('memory_stale_revision')
      store.remove(WORKSPACE_A, { entryId: entry.id, expectedRevision: 2 })
      expect(store.list(WORKSPACE_A).entries).toEqual([])
    })
  })

  test('rejects empty, oversize, and malformed input', () => {
    withStore(({ store }) => {
      expect(codeOf(() => store.create(WORKSPACE_A, { text: '   ' }))).toBe('memory_invalid_input')
      expect(codeOf(() => store.create(WORKSPACE_A, { text: 'x'.repeat(2_001) }))).toBe(
        'memory_invalid_input'
      )
      expect(store.create(WORKSPACE_A, { text: 'x'.repeat(2_000) }).text).toHaveLength(2_000)
      expect(codeOf(() => store.create(WORKSPACE_A, { text: 42 }))).toBe('memory_invalid_input')
      expect(codeOf(() => store.create('../escape', { text: 'x' }))).toBe('memory_invalid_input')
      expect(
        codeOf(() =>
          store.update(WORKSPACE_A, { entryId: '../../etc/passwd', expectedRevision: 1, text: 'x' })
        )
      ).toBe('memory_invalid_input')
    })
  })

  test('agent proposals stay pending until accepted; a rejected proposal is deleted', () => {
    withStore(({ store }) => {
      const kept = store.propose(WORKSPACE_A, { text: 'proposal to keep' })
      const dropped = store.propose(WORKSPACE_A, { text: 'proposal to drop' })
      expect(kept).toMatchObject({ source: 'agent', status: 'pending' })
      // Pending entries are never injected.
      expect(store.preamble(WORKSPACE_A)).toBeUndefined()

      const accepted = store.accept(WORKSPACE_A, { entryId: kept.id, expectedRevision: 1 })
      expect(accepted).toMatchObject({ status: 'active', source: 'agent', revision: 2 })
      expect(
        codeOf(() => store.accept(WORKSPACE_A, { entryId: kept.id, expectedRevision: 2 }))
      ).toBe('memory_invalid_state')
      expect(
        codeOf(() => store.reject(WORKSPACE_A, { entryId: kept.id, expectedRevision: 2 }))
      ).toBe('memory_invalid_state')

      store.reject(WORKSPACE_A, { entryId: dropped.id, expectedRevision: 1 })
      expect(store.list(WORKSPACE_A).entries.map((entry) => entry.id)).toEqual([kept.id])
      expect(store.preamble(WORKSPACE_A)?.text).toContain('proposal to keep')
    })
  })

  test('bounds the pending proposals and the entries per workspace', () => {
    withStore(({ store }) => {
      for (let index = 0; index < 20; index += 1) {
        store.propose(WORKSPACE_A, { text: `p${String(index)}` })
      }
      expect(codeOf(() => store.propose(WORKSPACE_A, { text: 'overflow' }))).toBe(
        'memory_limit_exceeded'
      )
      for (let index = 0; index < 180; index += 1) {
        store.create(WORKSPACE_A, { text: `e${String(index)}` })
      }
      expect(codeOf(() => store.create(WORKSPACE_A, { text: 'overflow' }))).toBe(
        'memory_limit_exceeded'
      )
      // Another workspace has its own budget.
      expect(store.create(WORKSPACE_B, { text: 'fine' }).workspaceId).toBe(WORKSPACE_B)
    })
  })

  test('the injection switch defaults on, persists per workspace, and keeps entries', () => {
    withStore(({ dir, store }) => {
      store.create(WORKSPACE_A, { text: 'note' })
      expect(store.injectionEnabled(WORKSPACE_A)).toBe(true)
      expect(store.setInjectionEnabled(WORKSPACE_A, false)).toBe(false)
      expect(store.preamble(WORKSPACE_A)).toBeUndefined()
      expect(store.list(WORKSPACE_A)).toMatchObject({ injectionEnabled: false })
      expect(store.list(WORKSPACE_A).entries).toHaveLength(1)
      expect(store.injectionEnabled(WORKSPACE_B)).toBe(true)
      expect(codeOf(() => store.setInjectionEnabled(WORKSPACE_A, 'no'))).toBe(
        'memory_invalid_input'
      )
      // A fresh store over the same directory reads the persisted switch.
      const reopened = createMemoryStore({ contentDir: dir, key: () => randomBytes(32) })
      expect(reopened.injectionEnabled(WORKSPACE_A)).toBe(false)
    })
  })
})

describe('memory preamble', () => {
  const entry = (id: string, createdAt: string, text: string, status = 'active') =>
    ({
      id,
      workspaceId: WORKSPACE_A,
      text,
      source: 'user',
      status,
      createdAt,
      updatedAt: createdAt,
      revision: 1,
    }) as const

  test('orders newest first and skips pending entries', () => {
    const preamble = compileMemoryPreamble([
      entry('00000000-0000-4000-8000-000000000001', '2026-10-01T00:00:01.000Z', 'old'),
      entry('00000000-0000-4000-8000-000000000002', '2026-10-01T00:00:03.000Z', 'new'),
      entry(
        '00000000-0000-4000-8000-000000000003',
        '2026-10-01T00:00:02.000Z',
        'pending',
        'pending'
      ),
    ])
    expect(preamble).toMatchObject({ includedEntries: 2 })
    expect(preamble?.diagnostic).toBeUndefined()
    expect(preamble?.text).toBe(`${MEMORY_PREAMBLE_HEADER}\n- new\n- old`)
    expect(preamble?.bytes).toBe(new TextEncoder().encode(preamble!.text).byteLength)
  })

  test('returns nothing for no active entries', () => {
    expect(compileMemoryPreamble([])).toBeUndefined()
  })

  test('includes whole entries only and reports the overflow', () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      entry(
        `00000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`,
        `2026-10-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        // Multi-byte text: the bound is UTF-8 bytes, not characters.
        'é'.repeat(2_000)
      )
    )
    const preamble = compileMemoryPreamble(entries)!
    expect(preamble.bytes).toBeLessThanOrEqual(MEMORY_PREAMBLE_MAX_BYTES)
    expect(preamble.includedEntries).toBe(4)
    expect(preamble.diagnostic).toEqual({
      code: 'memory_truncated',
      includedEntries: 4,
      omittedEntries: 8,
      limitBytes: MEMORY_PREAMBLE_MAX_BYTES,
    })
    expect(preamble.text.split('\n- ')).toHaveLength(5)
  })

  test('reports an entry that cannot fit at all instead of cutting it', () => {
    const preamble = compileMemoryPreamble(
      [entry('00000000-0000-4000-8000-000000000001', '2026-10-01T00:00:01.000Z', 'x'.repeat(500))],
      200
    )
    expect(preamble).toEqual({
      text: '',
      bytes: 0,
      includedEntries: 0,
      diagnostic: {
        code: 'memory_truncated',
        includedEntries: 0,
        omittedEntries: 1,
        limitBytes: 200,
      },
    })
  })
})

describe('memory_* trusted commands', () => {
  function surface(authorized: string | undefined) {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-memory-commands-'))
    let current = authorized
    const invoke = createCommandSurface(dataDir, { authorizedWorkspaceId: () => current })
    return {
      dataDir,
      invoke: (cmd: string, args?: Record<string, unknown>) =>
        invoke(cmd, args) as { ok: boolean; value?: unknown; error?: string },
      authorize: (workspaceId: string | undefined) => {
        current = workspaceId
      },
    }
  }

  test('serve the authorized workspace end to end', () => {
    const shell = surface(WORKSPACE_A)
    try {
      const created = shell.invoke('memory_create', { workspaceId: WORKSPACE_A, text: 'note' })
      expect(created.ok).toBe(true)
      const entry = created.value as { id: string; revision: number }
      const updated = shell.invoke('memory_update', {
        workspaceId: WORKSPACE_A,
        entryId: entry.id,
        expectedRevision: 1,
        text: 'edited',
      })
      expect(updated).toMatchObject({ ok: true, value: { text: 'edited', revision: 2 } })
      expect(
        shell.invoke('memory_update', {
          workspaceId: WORKSPACE_A,
          entryId: entry.id,
          expectedRevision: 1,
          text: 'stale',
        })
      ).toEqual({ ok: false, error: 'memory_stale_revision' })
      expect(
        shell.invoke('memory_injection_save', { workspaceId: WORKSPACE_A, enabled: false })
      ).toEqual({ ok: true, value: { injectionEnabled: false } })
      expect(shell.invoke('memory_list', { workspaceId: WORKSPACE_A })).toMatchObject({
        ok: true,
        value: {
          injectionEnabled: false,
          unreadable: 0,
          entries: [{ id: entry.id, text: 'edited' }],
        },
      })
      expect(
        shell.invoke('memory_delete', {
          workspaceId: WORKSPACE_A,
          entryId: entry.id,
          expectedRevision: 2,
        })
      ).toEqual({ ok: true, value: null })
      expect(shell.invoke('memory_list', { workspaceId: WORKSPACE_A })).toMatchObject({
        value: { entries: [] },
      })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('accept and reject proposals through the command family', () => {
    const shell = surface(WORKSPACE_A)
    try {
      const store = createMemoryStore({
        contentDir: join(shell.dataDir, 'local-content'),
        // The same device key the command surface's default store uses.
        key: () => loadDeviceKey(join(shell.dataDir, 'desktop-state', 'device.key')),
      })
      const keep = store.propose(WORKSPACE_A, { text: 'keep me' })
      const drop = store.propose(WORKSPACE_A, { text: 'drop me' })
      expect(
        shell.invoke('memory_accept_proposal', {
          workspaceId: WORKSPACE_A,
          entryId: keep.id,
          expectedRevision: 1,
        })
      ).toMatchObject({ ok: true, value: { status: 'active', source: 'agent' } })
      expect(
        shell.invoke('memory_reject_proposal', {
          workspaceId: WORKSPACE_A,
          entryId: drop.id,
          expectedRevision: 1,
        })
      ).toEqual({ ok: true, value: null })
      const listed = shell.invoke('memory_list', { workspaceId: WORKSPACE_A }).value as {
        entries: Array<{ id: string }>
      }
      expect(listed.entries.map((entry) => entry.id)).toEqual([keep.id])
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('refuse every workspace but the authorized one, and fail closed without authority', () => {
    const shell = surface(WORKSPACE_A)
    try {
      const created = shell.invoke('memory_create', { workspaceId: WORKSPACE_A, text: 'mine' })
        .value as { id: string }
      for (const [cmd, args] of [
        ['memory_list', {}],
        ['memory_create', { text: 'x' }],
        ['memory_update', { entryId: created.id, expectedRevision: 1, text: 'x' }],
        ['memory_delete', { entryId: created.id, expectedRevision: 1 }],
        ['memory_accept_proposal', { entryId: created.id, expectedRevision: 1 }],
        ['memory_reject_proposal', { entryId: created.id, expectedRevision: 1 }],
        ['memory_injection_save', { enabled: false }],
      ] as const) {
        expect(shell.invoke(cmd, { ...args, workspaceId: WORKSPACE_B })).toEqual({
          ok: false,
          error: 'memory_workspace_unauthorized',
        })
      }
      shell.authorize(undefined)
      expect(shell.invoke('memory_list', { workspaceId: WORKSPACE_A })).toEqual({
        ok: false,
        error: 'memory_workspace_unauthorized',
      })
      // A switch of the shell's authorized workspace moves the gate with it.
      shell.authorize(WORKSPACE_B)
      expect(shell.invoke('memory_list', { workspaceId: WORKSPACE_B })).toMatchObject({
        ok: true,
        value: { entries: [] },
      })
      expect(shell.invoke('memory_list', { workspaceId: 'not-a-uuid' })).toEqual({
        ok: false,
        error: 'memory_invalid_input',
      })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('without an injected authority every memory command fails closed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-memory-commands-'))
    try {
      const invoke = createCommandSurface(dataDir)
      expect(invoke('memory_list', { workspaceId: WORKSPACE_A })).toEqual({
        ok: false,
        error: 'memory_workspace_unauthorized',
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('workspace memory deletion', () => {
  test('purges active and pending entries and its injection preference; preserves a sibling and retries', () => {
    withStore(({ dir, store }) => {
      const own = store.create(WORKSPACE_A, { text: 'workspace owned' })
      store.propose(WORKSPACE_A, { text: 'pending proposal' })
      const sibling = store.create(WORKSPACE_B, { text: 'keep sibling' })
      store.setInjectionEnabled(WORKSPACE_A, false)
      store.setInjectionEnabled(WORKSPACE_B, false)
      expect(store.purgeWorkspace(WORKSPACE_A)).toBe(2)
      expect(store.list(WORKSPACE_A)).toEqual({
        entries: [],
        injectionEnabled: true,
        unreadable: 0,
      })
      expect(store.list(WORKSPACE_B).entries).toEqual([sibling])
      expect(store.injectionEnabled(WORKSPACE_B)).toBe(false)
      expect(readdirSync(join(dir, 'memory'))).not.toContain(`${own.id}.json`)
      expect(store.purgeWorkspace(WORKSPACE_A)).toBe(0)
    })
  })
  test('refuses an unreadable or relabelled record before deleting any entry', () => {
    withStore(({ dir, store }) => {
      const own = store.create(WORKSPACE_A, { text: 'own' })
      const sibling = store.create(WORKSPACE_B, { text: 'foreign' })
      const file = join(dir, 'memory', `${sibling.id}.json`)
      const record = JSON.parse(readFileSync(file, 'utf8'))
      writeFileSync(file, JSON.stringify({ ...record, workspaceId: WORKSPACE_A }))
      expect(codeOf(() => store.purgeWorkspace(WORKSPACE_A))).toBe('memory_unavailable')
      expect(readdirSync(join(dir, 'memory'))).toContain(`${own.id}.json`)
      expect(readdirSync(join(dir, 'memory'))).toContain(`${sibling.id}.json`)
    })
  })
})
