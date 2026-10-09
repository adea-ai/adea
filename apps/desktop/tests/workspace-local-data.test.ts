import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMemoryStore } from '../shell/src/memory/store'
import {
  createHarnessAccountProfileStore,
  createWorkspaceConnectionsStore,
  detachWorkspaceConnections,
  scopeDigest,
} from '../shell/src/dev-runtime/connections/store'
import { workspaceLocalData, assertWorkspaceDataPath } from '../shell/src/workspace-local-data'
const a = {
  accountId: '00000000-0000-4000-8000-000000000010',
  workspaceId: '00000000-0000-4000-8000-00000000000a',
  runtimeNodeId: '00000000-0000-4000-8000-000000000011',
}
const b = { ...a, workspaceId: '00000000-0000-4000-8000-00000000000b' }
const own = '00000000-0000-4000-8000-000000000001'
const sibling = '00000000-0000-4000-8000-000000000002'
function fixture(
  run: (context: {
    dir: string
    memory: ReturnType<typeof createMemoryStore>
    cleanup: ReturnType<typeof workspaceLocalData>
  }) => void
) {
  const dir = mkdtempSync(join(tmpdir(), 'adea-local-purge-'))
  try {
    mkdirSync(join(dir, 'local-content'), { recursive: true })
    const memory = createMemoryStore({ contentDir: join(dir, 'local-content'), key: () => key })
    const key = randomBytes(32)
    writeFileSync(
      join(dir, 'local-content', 'index.json'),
      JSON.stringify({
        [own]: { id: own, workspaceId: a.workspaceId },
        [sibling]: { id: sibling, workspaceId: b.workspaceId },
      })
    )
    writeFileSync(join(dir, 'local-content', `${own}.sealed`), 'own ciphertext')
    writeFileSync(join(dir, 'local-content', `${sibling}.sealed`), 'sibling ciphertext')
    run({ dir, memory, cleanup: workspaceLocalData({ dataDir: dir, scope: a, memory }) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
describe('workspace device data ownership', () => {
  test('purges only the workspace and its registry records, leaves sibling and reusable data, and retries', () =>
    fixture(({ dir, memory, cleanup }) => {
      memory.create(a.workspaceId, { text: 'own note' })
      const note = memory.create(b.workspaceId, { text: 'sibling note' })
      const registry = join(dir, 'dev-runtime', 'roots', 'bookmarks.json')
      mkdirSync(join(dir, 'dev-runtime', 'roots'), { recursive: true })
      writeFileSync(
        registry,
        JSON.stringify({
          schemaVersion: 1,
          savedAt: '',
          records: [
            { id: own, scope: a },
            { id: sibling, scope: b },
          ],
        })
      )
      writeFileSync(join(dir, 'account-secret'), 'keep shared credential')
      expect(cleanup.purge()).toMatchObject({
        contentIds: [own],
        memoryEntries: 1,
        registryRecords: 1,
      })
      expect(existsSync(join(dir, 'local-content', `${own}.sealed`))).toBe(false)
      expect(readFileSync(join(dir, 'local-content', `${sibling}.sealed`), 'utf8')).toBe(
        'sibling ciphertext'
      )
      expect(memory.list(b.workspaceId).entries).toEqual([note])
      expect(JSON.parse(readFileSync(registry, 'utf8')).records).toEqual([
        { id: sibling, scope: b },
      ])
      expect(readFileSync(join(dir, 'account-secret'), 'utf8')).toBe('keep shared credential')
      expect(cleanup.purge()).toMatchObject({
        contentIds: [],
        memoryEntries: 0,
        registryRecords: 0,
      })
    }))
  test('rejects a ciphertext symlink before touching memory or an outside file', () =>
    fixture(({ dir, memory, cleanup }) => {
      const note = memory.create(a.workspaceId, { text: 'own note' })
      const file = join(dir, 'local-content', `${own}.sealed`)
      rmSync(file)
      const outside = join(dir, 'outside')
      writeFileSync(outside, 'preserve')
      symlinkSync(outside, file)
      expect(() => cleanup.purge()).toThrow('workspace_cleanup_ambiguous_data')
      expect(memory.list(a.workspaceId).entries).toEqual([note])
      expect(readFileSync(outside, 'utf8')).toBe('preserve')
    }))
  test('rejects another authority scope for the same workspace instead of claiming full cleanup', () =>
    fixture(({ dir, cleanup }) => {
      const registry = join(dir, 'dev-runtime', 'roots', 'bookmarks.json')
      mkdirSync(join(dir, 'dev-runtime', 'roots'), { recursive: true })
      writeFileSync(
        registry,
        JSON.stringify({
          schemaVersion: 1,
          savedAt: '',
          records: [{ id: own, scope: { ...a, runtimeNodeId: 'other' } }],
        })
      )
      expect(() => cleanup.purge()).toThrow('workspace_cleanup_additional_scope')
      expect(existsSync(join(dir, 'local-content', `${own}.sealed`))).toBe(true)
    }))
})

test('detaches reverse account-profile links but preserves reusable credentials and sibling bindings', () =>
  fixture(({ dir }) => {
    const profiles = createHarnessAccountProfileStore({ dataDir: dir })
    const profile = {
      id: own,
      owner: { accountId: a.accountId, runtimeNodeId: a.runtimeNodeId },
      harnessId: 'claude-code' as const,
      label: 'Reusable',
      credentialRefId: sibling,
      credentialScope: a,
      version: 1,
      createdAt: new Date().toISOString(),
      boundBy: [scopeDigest(a), scopeDigest(b)].toSorted(),
    }
    profiles.save([profile])
    const bindings = createWorkspaceConnectionsStore({ dataDir: dir, scope: a })
    bindings.write({
      scope: a,
      version: 1,
      updatedAt: new Date().toISOString(),
      gitHosting: [],
      harnessAccounts: [],
    })
    detachWorkspaceConnections({ dataDir: dir, scope: a })
    expect(profiles.load()).toEqual([{ ...profile, version: 2, boundBy: [scopeDigest(b)] }])
    detachWorkspaceConnections({ dataDir: dir, scope: a })
    expect(profiles.load()[0]?.version).toBe(2)
  }))

test('retains a failed managed-clone recovery record and does not purge unrelated data', () =>
  fixture(({ dir, cleanup }) => {
    const file = join(dir, 'dev-runtime', 'repos', 'registry.json')
    mkdirSync(join(dir, 'dev-runtime', 'repos'), { recursive: true })
    const records = [{ id: own, scope: a, layout: 'bare_managed', lifecycle: 'unavailable' }]
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, savedAt: '', records }))
    expect(() => cleanup.purge()).toThrow('managed_repositories_pending')
    expect(JSON.parse(readFileSync(file, 'utf8')).records).toEqual(records)
    expect(existsSync(join(dir, 'local-content', `${own}.sealed`))).toBe(true)
  }))

test('refuses an unindexed ciphertext and a symlinked parent before physical cleanup', () =>
  fixture(({ dir, cleanup }) => {
    const orphan = join(dir, 'local-content', 'ffffffffffffffffffffffffffffffff.sealed')
    writeFileSync(orphan, 'unknown owner')
    expect(() => cleanup.purge()).toThrow('ambiguous_data')
    expect(existsSync(join(dir, 'local-content', `${own}.sealed`))).toBe(true)
    rmSync(orphan)
    const target = join(dir, 'outside-profiles')
    mkdirSync(target)
    mkdirSync(join(dir, 'dev-runtime', 'browser'), { recursive: true })
    symlinkSync(target, join(dir, 'dev-runtime', 'browser', 'profiles'))
    expect(() =>
      assertWorkspaceDataPath(dir, join(dir, 'dev-runtime', 'browser', 'profiles', 'owned-profile'))
    ).toThrow('ambiguous_data')
  }))
