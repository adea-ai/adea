import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  CATEGORY,
  LIMITS,
  canonicalEnvelopeBytes,
  createEnvelope,
  isEnabled,
  publishEntry,
} from './vp-r2-cache.mjs'
import {
  digest,
  listedKeys,
  machine,
  qualifyMatrix,
  qualifyTransfer,
  toolchainId,
  transferIdentity,
} from './vp-r2-cache-transfer.mjs'
import { clientRuntime, pinnedClient } from './vp-r2-cache-replay.mjs'
import {
  NAMESPACE,
  OTHER_CLIENT,
  OTHER_NAMESPACE,
  PINNED_CLIENT,
  TOOLCHAINS,
  binaryEntry,
  boundaryEntry,
  largeEntry,
  machines,
} from './vp-r2-cache-transfer-fixtures.mjs'
import { createMemoryStore } from './vp-r2-cache-fixtures.mjs'

const profiles = machines()

/** An envelope with its recorded creation time blanked, so two machines' envelopes can be compared. */
const blankTime = (envelope: Record<string, unknown>) => ({ ...envelope, created_at: '' })

describe('the machines of the qualification', () => {
  test('two checkouts of one repository on one platform are one trust domain', () => {
    expect(profiles['darwin-a'].scope.id).toBe(profiles['darwin-b'].scope.id)
    expect(profiles['darwin-a'].toolchain).toBe(profiles['darwin-b'].toolchain)
  })

  test('another platform, another client and another namespace are other domains', () => {
    expect(profiles.linux.scope.id).not.toBe(profiles['darwin-a'].scope.id)
    expect(profiles['darwin-other-client'].scope.id).not.toBe(profiles['darwin-a'].scope.id)
    expect(profiles['darwin-other-namespace'].scope.id).not.toBe(profiles['darwin-a'].scope.id)
  })

  test('the toolchain identity holds the platform and never a path', () => {
    const id = toolchainId({
      platform: 'linux',
      arch: 'x64',
      libc: 'glibc2.39',
      node: '24.21.0',
      bun: '1.4.3',
      nodeSha: 'aa'.repeat(32),
      bunSha: 'bb'.repeat(32),
    })
    expect(id).toBe('linux-x64.glibc2.39.node24.21.0-aaaaaaaaaaaa.bun1.4.3-bbbbbbbbbbbb')
    expect(id).not.toContain('/')
    expect(TOOLCHAINS.darwin.startsWith('darwin-arm64.')).toBe(true)
    expect(TOOLCHAINS.linux.startsWith('linux-x64.')).toBe(true)
  })
})

describe('a compatible cross-machine transfer', () => {
  test('the entry is replayed by another checkout of the same repository', async () => {
    const store = createMemoryStore()
    const entry = binaryEntry('cross-machine')
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
    })
    expect(result.sameDomain).toBe(true)
    expect(result.published).toBe(true)
    expect(result.replayable).toBe(true)
    expect(result.refusedWith).toBe(null)
    expect(result.envelopeRefusedWith).toBe(null)
    expect(result.archiveIdentical).toBe(true)
    expect(result.archiveSha256).toBe(digest(entry.blob))
    expect(result.stagedObjects).toEqual([])
    expect(result.publishedObjects).toHaveLength(1)
  })

  test('the object keys carry the shared domain and no path of either machine', async () => {
    const store = createMemoryStore()
    const entry = binaryEntry('keys')
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
    })
    const key = result.publishedObjects[0]
    expect(key).toContain(profiles['darwin-a'].scope.id)
    expect(key).not.toContain('/Users/')
    expect(key).not.toContain('/home/')
    expect(key).not.toContain('/tmp/')
  })

  test('the transfer identity is the same on both machines', async () => {
    const store = createMemoryStore()
    const entry = binaryEntry('identity')
    const first = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
      createdAt: '2026-10-19T00:00:00.000Z',
    })
    const second = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-b'],
      to: profiles['darwin-a'],
      createdAt: '2026-10-20T00:00:00.000Z',
    })
    expect(second.transferIdentity).toBe(first.transferIdentity)
    expect(second.replayable).toBe(true)
  })

  test('the envelope bytes of two machines differ only in the recorded creation time', () => {
    const entry = binaryEntry('envelope-bytes')
    const scope = profiles['darwin-a'].scope
    const first = createEnvelope({
      scope,
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    })
    const second = createEnvelope({
      scope,
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-20T00:00:00.000Z',
    })
    expect(
      canonicalEnvelopeBytes(blankTime(second) as never).equals(
        canonicalEnvelopeBytes(blankTime(first) as never)
      )
    ).toBe(true)
    expect(transferIdentity(second)).toBe(transferIdentity(first))
  })
})

describe('the boundaries of a transfer', () => {
  test('another platform is refused, and it is refused precisely', async () => {
    const store = createMemoryStore()
    const entry = binaryEntry('cross-platform')
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles.linux,
    })
    expect(result.sameDomain).toBe(false)
    expect(result.published).toBe(true)
    expect(result.replayable).toBe(false)
    // The target cannot name the object at all: the key space is the domain's.
    expect(result.refusedWith).toBe(CATEGORY.notFound)
    // And the envelope itself refuses the target, naming the compatibility context.
    expect(result.envelopeRefusedWith).toBe(CATEGORY.compatibility)
  })

  test('another client version is refused as a compatibility boundary', async () => {
    const store = createMemoryStore()
    const entry = binaryEntry('cross-client')
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-other-client'],
    })
    expect(result.replayable).toBe(false)
    expect(result.envelopeRefusedWith).toBe(CATEGORY.compatibility)
  })

  test('another repository sharing the store is refused as a trust domain boundary', async () => {
    const store = createMemoryStore()
    const entry = binaryEntry('cross-namespace')
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-other-namespace'],
    })
    expect(result.replayable).toBe(false)
    expect(result.refusedWith).toBe(CATEGORY.notFound)
    expect(result.envelopeRefusedWith).toBe(CATEGORY.trustDomain)
  })

  test('the whole matrix of the fixture machines is qualified', async () => {
    const rows = await qualifyMatrix({
      newStore: () => createMemoryStore(),
      entry: binaryEntry('matrix'),
      machines: Object.values(profiles),
    })
    expect(rows).toHaveLength(25)
    for (const row of rows) {
      if (row.sameDomain) {
        expect(row.replayable).toBe(true)
        expect(row.refusedWith).toBe(null)
      } else {
        expect(row.replayable).toBe(false)
        expect(row.refusedWith).toBe(CATEGORY.notFound)
      }
    }
  })
})

describe('what survives a transfer', () => {
  test('an archive that holds a multipart boundary arrives whole', async () => {
    const store = createMemoryStore()
    const entry = boundaryEntry()
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
    })
    expect(result.replayable).toBe(true)
    expect(result.archiveSha256).toBe(digest(entry.blob))
  })

  test('a large archive arrives whole', async () => {
    const store = createMemoryStore()
    const entry = largeEntry()
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
    })
    expect(result.replayable).toBe(true)
    expect(result.archiveSha256).toBe(digest(entry.blob))
  })

  test('an archive that was changed in the store is refused by its digest', async () => {
    const store = createMemoryStore()
    const entry = binaryEntry('tampered')
    const published = await publishEntry(store, entry, { scope: profiles['darwin-a'].scope })
    expect(published.ok).toBe(true)
    const blobKey = [...store.objects.keys()].find((name) => name.startsWith('blobs/'))
    store.objects.set(blobKey, Buffer.from('changed'))
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
      publish: false,
    })
    // The published envelope is still the source's, but the archive no longer matches its digest.
    expect(result.refusedWith).toBe(null)
    expect(result.blobRefusedWith).toBe(CATEGORY.integrity)
    expect(result.replayable).toBe(false)
  })

  test('an entry that is larger than the bound is refused and nothing is published', async () => {
    const store = createMemoryStore()
    const entry = largeEntry()
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
      limits: { ...LIMITS, maxBlobBytes: 1024 },
    })
    expect(result.published).toBe(false)
    expect(result.publishCategory).toBe(CATEGORY.tooLarge)
    expect(result.replayable).toBe(false)
    expect(result.publishedObjects).toEqual([])
    expect(result.stagedObjects).toEqual([])
  })

  test('a transfer that fails in the middle publishes nothing and leaves nothing behind', async () => {
    const store = createMemoryStore({ failCopy: true })
    const entry = binaryEntry('interrupted')
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
    })
    expect(result.published).toBe(false)
    expect(result.replayable).toBe(false)
    expect(result.publishedObjects).toEqual([])
    expect(result.stagedObjects).toEqual([])
    expect(result.refusedWith).not.toBeUndefined()
  })

  test('a stalled store ends the transfer with a fallback rather than an exception', async () => {
    const store = createMemoryStore({ stall: ['put'] })
    const entry = binaryEntry('stalled')
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
      deadlineMs: 60,
    })
    expect(result.published).toBe(false)
    expect(result.publishCategory).toBe(CATEGORY.timeout)
    expect(result.replayable).toBe(false)
  })

  test('an envelope of an unknown version is refused', async () => {
    const store = createMemoryStore()
    const entry = binaryEntry('version')
    const published = await publishEntry(store, entry, { scope: profiles['darwin-a'].scope })
    const key = published.entryKey
    const bytes = JSON.parse(store.objects.get(key).toString('utf8'))
    bytes.v = bytes.v + 1
    store.objects.set(key, Buffer.from(JSON.stringify(bytes)))
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
      publish: false,
    })
    expect(result.refusedWith).toBe(CATEGORY.invalidEnvelope)
  })
})

describe('the qualification helpers', () => {
  test('a machine without a namespace, a client or a toolchain is refused', () => {
    expect(() => machine({ namespace: '', client: PINNED_CLIENT, toolchain: 'x' })).toThrow()
    expect(() => machine({ namespace: NAMESPACE, client: '', toolchain: 'x' })).toThrow()
    expect(() => machine({ namespace: NAMESPACE, client: PINNED_CLIENT, toolchain: '' })).toThrow()
  })

  test('a store that cannot list its objects reports no leftovers rather than failing', () => {
    expect(listedKeys({})).toBe(null)
    expect(listedKeys(createMemoryStore())).toEqual([])
  })

  test('the fixture clients and namespaces are the ones the qualification names', () => {
    expect(PINNED_CLIENT).toBe('1.3.0')
    expect(OTHER_CLIENT).not.toBe(PINNED_CLIENT)
    expect(OTHER_NAMESPACE).not.toBe(NAMESPACE)
  })
})

describe('what the qualification does not do', () => {
  test('the pinned client still has no export and no import', () => {
    const client = pinnedClient(process.cwd())
    if (!client) return
    const help = spawnSync(clientRuntime(), [client.bin, 'cache', '--help'], {
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(help.stdout).toContain('clean')
    expect(help.stdout).not.toMatch(/export/i)
    expect(help.stdout).not.toMatch(/import/i)
  }, 180_000)

  test('nothing in the repository turns the transport on', () => {
    const root = process.cwd()
    const manifest = readFileSync(join(root, 'package.json'), 'utf8')
    expect(manifest).not.toContain('ADEA_VP_R2_CACHE_ENABLED')
    const workflows = join(root, '.github', 'workflows')
    for (const name of readdirSync(workflows)) {
      const text = readFileSync(join(workflows, name), 'utf8')
      expect(text).not.toContain('ADEA_VP_R2_CACHE_ENABLED')
      expect(text).not.toContain('VP_REMOTE_CACHE')
    }
  })

  test('the transport is off unless it is turned on explicitly', () => {
    expect(isEnabled({})).toBe(false)
    expect(isEnabled({ ADEA_VP_R2_CACHE_ENABLED: '0' })).toBe(false)
    expect(isEnabled({ ADEA_VP_R2_CACHE_ENABLED: '1' })).toBe(true)
  })
})
