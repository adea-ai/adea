import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CATEGORY,
  LIMITS,
  canonicalEnvelopeBytes,
  createEnvelope,
  isEnabled,
  parseEnvelope,
  publishEntry,
} from './vp-r2-cache.mjs'
import {
  digest,
  listedKeys,
  machine,
  qualifyMatrix,
  qualifyTransfer,
  readStoredEnvelope,
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

// The pinned client of this checkout. Without it the pinned-client qualification is not established, and the checks
// that need it are skipped visibly rather than passing quietly.
const client = pinnedClient(process.cwd())

/** Blocks the event loop for `ms`, the way a slow synchronous read would. */
const block = (ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // the event loop is busy here
  }
}

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

describe('the final read of the stored envelope', () => {
  test('a read that is rejected ends the qualification with a refusal', async () => {
    const inner = createMemoryStore()
    const store = {
      ...inner,
      get: (key: string, options: unknown) => {
        if (key.startsWith('entries/'))
          return Promise.reject(new Error('the store refused the read'))
        return inner.get(key, options as never)
      },
    }
    const entry = binaryEntry('rejecting-read')
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
      deadlineMs: 500,
    })
    expect(result.replayable).toBe(false)
    expect(result.storedRefusedWith).toBe(CATEGORY.storeRead)
  })

  test('a read that never answers ends the qualification within the deadline', async () => {
    const inner = createMemoryStore()
    const store = {
      ...inner,
      get: (key: string, options: unknown) => {
        if (key.startsWith('entries/')) return new Promise(() => {})
        return inner.get(key, options as never)
      },
    }
    const entry = binaryEntry('stalled-read')
    const started = Date.now()
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
      deadlineMs: 120,
    })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.replayable).toBe(false)
  })

  test('a target envelope that differs from the source read is not replayable', async () => {
    const inner = createMemoryStore()
    const entry = binaryEntry('changed-value')
    const published = await publishEntry(inner, entry, { scope: profiles['darwin-a'].scope })
    expect(published.ok).toBe(true)
    const original = inner.objects.get(published.entryKey)!
    // Another envelope under the same key with another value. It is valid: its digests match its own content.
    const changed = JSON.parse(original.toString('utf8'))
    const otherValue = Buffer.from('another value', 'utf8')
    changed.value = otherValue.toString('base64')
    changed.value_sha256 = digest(otherValue)
    const changedBytes = Buffer.from(JSON.stringify(changed))
    // The first read of the entry is the source's view; the later ones are the target's.
    let entryReads = 0
    const store = {
      ...inner,
      get: (key: string, options: unknown) => {
        if (key !== published.entryKey) return inner.get(key, options as never)
        entryReads += 1
        return entryReads === 1 ? original : changedBytes
      },
    }
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
      publish: false,
    })
    // The source saw the original value and the target read another one, so the report follows the target.
    expect(result.sourceValueIdentical).toBe(true)
    expect(result.valueIdentical).toBe(false)
    expect(result.replayable).toBe(false)
    expect(result.entryIdentical).toBe(false)
    // The identity is the one of the envelope the target read.
    expect(result.transferIdentity).toBe(
      transferIdentity(parseEnvelope(changedBytes, { scope: profiles['darwin-a'].scope }))
    )
  })

  test('a stored entry with another value is not the entry that was expected', async () => {
    const store = createMemoryStore()
    const entry = binaryEntry('mismatched-value')
    // The store holds an entry with the same key, task fingerprint key and archive, but another value.
    const other = { ...entry, value: Buffer.from('another value', 'utf8') }
    const published = await publishEntry(store, other, { scope: profiles['darwin-a'].scope })
    expect(published.ok).toBe(true)
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
      publish: false,
    })
    expect(result.replayable).toBe(false)
    expect(result.valueIdentical).toBe(false)
    expect(result.entryIdentical).toBe(false)
    // The identity is the one of the **stored** envelope, not of the expected input.
    const expected = createEnvelope({
      scope: profiles['darwin-a'].scope,
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    })
    expect(result.transferIdentity).not.toBe(transferIdentity(expected))
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

describe('the bounded reads of the qualification', () => {
  test('a read that is given an aborted signal ends at once', async () => {
    // A store that never answers, and a signal that was aborted before the read started.
    const store = { ...createMemoryStore(), get: () => new Promise(() => {}) }
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const read = await readStoredEnvelope(store, 'entries/x/entry.json', profiles['darwin-a'], {
      deadlineMs: 5000,
      signal: controller.signal,
    })
    expect(read.envelope).toBeUndefined()
    expect(read.refusedWith).toBe(CATEGORY.timeout)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('an already aborted signal refuses a read that resolves at once', async () => {
    // The store answers at once with a valid buffer. The signal was already aborted, so the read is refused before
    // the store is even asked.
    const inner = createMemoryStore()
    let asked = 0
    const store = {
      ...inner,
      get: (key: string, options: unknown) => {
        asked += 1
        return inner.get(key, options as never)
      },
    }
    const controller = new AbortController()
    controller.abort()
    const read = await readStoredEnvelope(store, 'entries/x/entry.json', profiles['darwin-a'], {
      deadlineMs: 5000,
      signal: controller.signal,
    })
    expect(read.envelope).toBeUndefined()
    expect(read.refusedWith).toBe(CATEGORY.timeout)
    expect(asked).toBe(0)
  })

  test('an adapter that returns something that is not a buffer is refused', async () => {
    // A malformed answer must not escape as a TypeError.
    const store = { ...createMemoryStore(), get: () => 42 as unknown as Buffer }
    const read = await readStoredEnvelope(store, 'entries/x/entry.json', profiles['darwin-a'], {
      maxBytes: 64,
    })
    expect(read.envelope).toBeUndefined()
    expect(read.refusedWith).toBe(CATEGORY.storeRead)
  })

  test('a read that blocks past the budget is not replayable', async () => {
    // The read blocks the event loop, so the timer cannot fire: the budget is measured on the clock, and the report
    // must not claim that the entry is replayable.
    const inner = createMemoryStore()
    const store = {
      ...inner,
      get: (key: string, options: unknown) => {
        block(25)
        return inner.get(key, options as never)
      },
    }
    const entry = binaryEntry('blocking-read')
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
      deadlineMs: 10,
    })
    expect(result.replayable).toBe(false)
    // The report may say that there is no target envelope at all, but it must not claim a value identity.
    expect(result.valueIdentical).not.toBe(true)
  })

  test('a store that returns more than the bound is refused before it is parsed', async () => {
    const store = { ...createMemoryStore(), get: () => Buffer.alloc(1024, 0x41) }
    const read = await readStoredEnvelope(store, 'entries/x/entry.json', profiles['darwin-a'], {
      maxBytes: 16,
    })
    expect(read.envelope).toBeUndefined()
    expect(read.refusedWith).toBe(CATEGORY.tooLarge)
  })

  test('the whole qualification runs under one deadline', async () => {
    // Every read takes 40ms; a 60ms budget cannot pay for four of them.
    const inner = createMemoryStore()
    const store = {
      ...inner,
      get: (key: string, options: unknown) =>
        new Promise((resolve) => {
          setTimeout(() => {
            // The read may be refused because the operation expired while it waited; that is an answer, not a throw.
            try {
              resolve(inner.get(key, options as never))
            } catch {
              resolve(null)
            }
          }, 40)
        }),
    }
    const entry = binaryEntry('one-deadline')
    const started = Date.now()
    const result = await qualifyTransfer({
      store,
      entry,
      from: profiles['darwin-a'],
      to: profiles['darwin-b'],
      deadlineMs: 60,
    })
    // The reads share one deadline, so the qualification ends with the budget and not with four times it.
    expect(Date.now() - started).toBeLessThan(120)
    expect(result.replayable).toBe(false)
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
  test('records whether the pinned-client qualification is established', () => {
    // Without the pinned client this checkout cannot say anything about the client's export and import, and the
    // check below is skipped. A skip is visible in the run, and no claim is made where the client is absent.
    if (client === null) {
      expect(existsSync('node_modules/vite-plus/package.json')).toBe(false)
      return
    }
    expect(client.asked).toContain(client.version)
  })

  test('the client discovery reports a checkout without the pinned client', () => {
    const empty = mkdtempSync(join(tmpdir(), 'vp-r2-no-client-'))
    try {
      expect(pinnedClient(empty)).toBe(null)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test.skipIf(!client)(
    'the pinned client still has no export and no import',
    async () => {
      const help = spawnSync(clientRuntime(), [client.bin, 'cache', '--help'], {
        encoding: 'utf8',
        timeout: 120_000,
      })
      expect(help.stdout).toContain('clean')
      expect(help.stdout).not.toMatch(/export/i)
      expect(help.stdout).not.toMatch(/import/i)
    },
    180_000
  )

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
