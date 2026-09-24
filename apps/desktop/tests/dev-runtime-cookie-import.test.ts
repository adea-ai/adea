// Cookie import end to end (#610): a real source store, the import service's
// plan/commit transaction, and the lane profile's own store as the write
// target — plus the wire plan the client sees, which must carry no cookie
// value at all.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DevCommand } from '../../../packages/types/src/dev-runtime'
import {
  decodeDevMutationPlan,
  devOperationDefinitions,
} from '../../../packages/types/src/dev-runtime'

import {
  createCookieImportService,
  type ImportedCookie,
} from '../shell/src/dev-runtime/browser/cookie-import'
import {
  deriveChromiumKey,
  readCookieSource,
} from '../shell/src/dev-runtime/browser/cookie-sources'
import {
  LaneCookieStoreError,
  createChromiumLaneCookieStore,
  encryptChromiumValue,
} from '../shell/src/dev-runtime/browser/lane-cookie-store'
import { createBrowserLaneRegistry } from '../shell/src/dev-runtime/browser/lane-registry'
import { createScreenshotStore } from '../shell/src/dev-runtime/browser/screenshots'
import { createBrowserProviders } from '../shell/src/dev-runtime/browser/providers'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const sessionId = '00000000-0000-4000-8000-0000000000b1'
const SECRET = 'lane-profile-secret'

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'adea-cookie-import-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** A Chromium source store written the way a browser writes one. */
function sourceStore(
  path: string,
  rows: ReadonlyArray<{
    domain: string
    name: string
    value: string
    sameSite?: number
  }>
): void {
  const key = deriveChromiumKey(SECRET)
  const database = new Database(path)
  database.exec(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, encrypted_value BLOB, value TEXT, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
    top_frame_site_key TEXT, has_cross_site_ancestor INTEGER
  )`)
  const insert = database.prepare(
    'INSERT INTO cookies VALUES ($host, $name, $value, $plain, $path, $expires, $secure, $httpOnly, $sameSite, $top, $flag)'
  )
  // One transaction for the whole fixture: a row-per-commit fixture spends its
  // time on fsync, and the bounds case writes ten thousand rows.
  const insertAll = database.transaction((rowsToWrite: typeof rows) => {
    for (const row of rowsToWrite)
      insert.run({
        $host: row.domain,
        $name: row.name,
        $value: encryptChromiumValue(row.value, key, row.domain),
        $plain: '',
        $path: '/',
        $expires: 13_400_000_000_000_000,
        $secure: 1,
        $httpOnly: 0,
        $sameSite: row.sameSite ?? 1,
        $top: '',
        $flag: 0,
      })
  })
  insertAll(rows)
  database.close()
}

function readSource(sourcePath: string) {
  return async (): Promise<readonly ImportedCookie[]> => {
    const result = readCookieSource(
      {
        id: 'chrome:Test',
        kind: 'chrome',
        label: 'Chrome',
        storePath: sourcePath,
        availability: 'available',
      },
      { keychainSecret: () => SECRET }
    )
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
    return result.cookies
  }
}

function laneStore(profileDirectory: string, secret = SECRET) {
  return createChromiumLaneCookieStore({
    profileDirectory,
    keychainService: 'Test Safe Storage',
    keychainSecret: () => secret,
  })
}

function rowsIn(profileDirectory: string): Array<Record<string, unknown>> {
  const path = join(profileDirectory, 'Default', 'Cookies')
  if (!existsSync(path)) return []
  const database = new Database(path, { readonly: true })
  try {
    return database
      .query(
        'SELECT host_key, name, value, encrypted_value, samesite, top_frame_site_key FROM cookies'
      )
      .all() as Array<Record<string, unknown>>
  } finally {
    database.close()
  }
}

describe('lane cookie store (#610)', () => {
  test('writes encrypted values a Chromium engine can read back', async () => {
    const { root, cleanup } = scratch()
    try {
      const store = laneStore(join(root, 'profile'))
      await store.write([
        {
          domain: '.example.com',
          name: 'session',
          value: 'secret-value',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
          partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false },
          expiresAt: new Date(1_800_000_000_000).toISOString(),
        },
      ])
      // At rest: ciphertext in the encrypted column, nothing in the plaintext
      // column, and the OS scheme marker in front.
      const rows = rowsIn(join(root, 'profile'))
      expect(rows).toHaveLength(1)
      const encrypted = rows[0]!.encrypted_value as Uint8Array
      expect(encrypted.byteLength).toBeGreaterThan(3)
      expect(Buffer.from(encrypted.subarray(0, 3)).toString('utf8')).toBe('v10')
      expect(Buffer.from(encrypted).includes(Buffer.from('secret-value'))).toBe(false)
      expect(rows[0]!.value).toBe('')

      const listed = await store.list()
      expect(listed).toEqual([
        {
          domain: '.example.com',
          name: 'session',
          value: 'secret-value',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
          partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false },
          expiresAt: new Date(1_800_000_000_000).toISOString(),
        },
      ])
    } finally {
      cleanup()
    }
  })

  test('a denied Keychain means no write at all, never a plaintext fallback', async () => {
    const { root, cleanup } = scratch()
    try {
      const profile = join(root, 'profile')
      const store = createChromiumLaneCookieStore({
        profileDirectory: profile,
        keychainService: 'Test Safe Storage',
        keychainSecret: () => null,
      })
      await expect(
        store.write([
          {
            domain: '.example.com',
            name: 'session',
            value: 'secret-value',
            path: '/',
            secure: true,
            httpOnly: false,
            sameSite: 'lax',
          },
        ])
      ).rejects.toBeInstanceOf(LaneCookieStoreError)
      // The profile was never populated: a denied key cannot leave a row.
      expect(rowsIn(profile)).toEqual([])
    } finally {
      cleanup()
    }
  })

  test('a row that cannot be decrypted fails the read instead of vanishing from the snapshot', async () => {
    const { root, cleanup } = scratch()
    try {
      const profile = join(root, 'profile')
      // Written under a different key: the rollback snapshot would silently
      // drop this row, so the read has to refuse.
      await laneStore(profile, 'another-secret').write([
        {
          domain: '.example.com',
          name: 'foreign',
          value: 'v',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax',
        },
      ])
      const store = laneStore(profile, SECRET)
      await expect(store.list()).rejects.toMatchObject({ code: 'decryption_failed' })
    } finally {
      cleanup()
    }
  })

  test('removal is coordinate-exact: a partition sibling survives', async () => {
    const { root, cleanup } = scratch()
    try {
      const store = laneStore(join(root, 'profile'))
      const plain: ImportedCookie = {
        domain: '.example.com',
        name: 'session',
        value: 'plain',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'lax',
      }
      const partitioned: ImportedCookie = {
        ...plain,
        value: 'partitioned',
        partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false },
      }
      await store.write([plain, partitioned])
      await store.remove([plain])
      const remaining = await store.list()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.value).toBe('partitioned')
    } finally {
      cleanup()
    }
  })
})

describe('cookie import through the service (#610)', () => {
  test('a real source imports into a real lane profile, replacing only its own families', async () => {
    const { root, cleanup } = scratch()
    try {
      const source = join(root, 'source-Cookies')
      sourceStore(source, [
        { domain: '.example.com', name: 'session', value: 'imported' },
        { domain: 'app.example.com', name: 'sub', value: 'imported-sub' },
        { domain: '.other.test', name: 'keep', value: 'out-of-scope' },
      ])
      const profile = join(root, 'profile')
      const target = laneStore(profile)
      await target.write([
        {
          domain: '.example.com',
          name: 'stale',
          value: 'old-value',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax',
        },
        {
          domain: '.unrelated.test',
          name: 'keep',
          value: 'survivor',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax',
        },
      ])

      const service = createCookieImportService()
      const plan = await service.plan({
        browserLaneId: 'lane-1',
        laneGeneration: 1,
        sourceProfileId: 'chrome:Test',
        domains: ['example.com'],
        readSource: readSource(source),
        targetStore: target,
      })
      // Scope: the accepted family only. example.com's subtree imports; the
      // other domain in the source is skipped, and the target's unrelated
      // cookie is untouched.
      expect(plan.stagedWrites.map((cookie) => cookie.name).toSorted()).toEqual(['session', 'sub'])
      expect(plan.skipped).toBe(1)
      expect(plan.stagedRemovals.map((cookie) => cookie.name)).toEqual(['stale'])

      const result = await service.commit(plan.id, plan.digest, target)
      expect(result).toMatchObject({
        browserLaneId: 'lane-1',
        imported: 2,
        skipped: 1,
        rolledBack: false,
      })

      const after = await target.list()
      const byName = Object.fromEntries(after.map((cookie) => [cookie.name, cookie.value]))
      expect(byName).toEqual({
        session: 'imported',
        sub: 'imported-sub',
        keep: 'survivor',
      })
    } finally {
      cleanup()
    }
  })

  test('a failed write rolls the whole import back to the pre-import values', async () => {
    const { root, cleanup } = scratch()
    try {
      const source = join(root, 'source-Cookies')
      sourceStore(source, [
        { domain: '.example.com', name: 'session', value: 'imported' },
        { domain: '.example.com', name: 'second', value: 'imported-too' },
      ])
      const profile = join(root, 'profile')
      const real = laneStore(profile)
      await real.write([
        {
          domain: '.example.com',
          name: 'original',
          value: 'original-value',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax',
        },
      ])
      // Fail the second write: the transaction must undo the removal AND the
      // first write, restoring the exact pre-import value.
      let writes = 0
      const failing = {
        list: () => real.list(),
        remove: (cookies: readonly ImportedCookie[]) => real.remove(cookies),
        write: async (cookies: readonly ImportedCookie[]) => {
          writes += 1
          if (writes === 2) throw new Error('store is full')
          await real.write(cookies)
        },
      }
      const service = createCookieImportService()
      const plan = await service.plan({
        browserLaneId: 'lane-1',
        laneGeneration: 1,
        sourceProfileId: 'chrome:Test',
        domains: ['example.com'],
        readSource: readSource(source),
        targetStore: failing,
      })
      const failure = await service.commit(plan.id, plan.digest, failing).then(
        () => null,
        (caught: Error & { code?: string }) => caught
      )
      // A failed import is a typed failure, and the rollback is the guarantee:
      // the removed original is back with its original value and the partially
      // written cookie is gone (only the original remains).
      expect(failure?.code).toBe('cookie_import_failed')
      const after = await real.list()
      expect(after.map((cookie) => [cookie.name, cookie.value])).toEqual([
        ['original', 'original-value'],
      ])
    } finally {
      cleanup()
    }
  })

  test('the spec bounds hold when the source is a real store', async () => {
    const { root, cleanup } = scratch()
    try {
      const source = join(root, 'source-Cookies')
      const many = Array.from({ length: 10_001 }, (_unused, index) => ({
        domain: '.example.com',
        name: `cookie-${index}`,
        value: 'v',
      }))
      sourceStore(source, many)
      const service = createCookieImportService()
      // The reader carries the same cap, so it would refuse this source first;
      // raising only ITS bound is what puts the service's own envelope check
      // on the line — which is the clause under test.
      const failure = await service
        .plan({
          browserLaneId: 'lane-1',
          laneGeneration: 1,
          sourceProfileId: 'chrome:Test',
          domains: ['example.com'],
          readSource: async () => {
            const result = readCookieSource(
              {
                id: 'chrome:Test',
                kind: 'chrome',
                label: 'Chrome',
                storePath: source,
                availability: 'available',
              },
              { keychainSecret: () => SECRET, maxCookies: 20_000 }
            )
            if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
            return result.cookies
          },
          targetStore: laneStore(join(root, 'profile')),
        })
        .then(
          () => null,
          (caught: Error & { code?: string }) => caught
        )
      expect(failure?.code).toBe('limit_exceeded')
    } finally {
      cleanup()
    }
  }, 120_000)

  test('a plan staged against another generation is refused at commit', async () => {
    const { root, cleanup } = scratch()
    try {
      const source = join(root, 'source-Cookies')
      sourceStore(source, [{ domain: '.example.com', name: 'session', value: 'imported' }])
      const target = laneStore(join(root, 'profile'))
      const service = createCookieImportService()
      const plan = await service.plan({
        browserLaneId: 'lane-1',
        laneGeneration: 1,
        sourceProfileId: 'chrome:Test',
        domains: ['example.com'],
        readSource: readSource(source),
        targetStore: target,
      })
      // The wire commit body carries no generation, so the caller passes the
      // live one: a lane that has since moved must not accept a plan computed
      // against the profile it used to have.
      const failure = await service
        .commit(plan.id, plan.digest, target, undefined, { laneGeneration: 2 })
        .then(
          () => null,
          (caught: Error & { code?: string }) => caught
        )
      expect(failure?.code).toBe('plan_stale')
      // The refused commit left the profile untouched.
      expect(await target.list()).toEqual([])
    } finally {
      cleanup()
    }
  })

  test('the excluded family is never read back in, even when the source carries it', async () => {
    const { root, cleanup } = scratch()
    try {
      const source = join(root, 'source-Cookies')
      sourceStore(source, [
        { domain: '.google.com', name: 'SID', value: 'device-bound' },
        { domain: '.example.com', name: 'session', value: 'imported' },
      ])
      const service = createCookieImportService()
      const plan = await service.plan({
        browserLaneId: 'lane-1',
        laneGeneration: 1,
        sourceProfileId: 'chrome:Test',
        // The caller asks for both; policy accepts one and excludes the other.
        domains: ['google.com', 'example.com'],
        readSource: readSource(source),
        targetStore: laneStore(join(root, 'profile')),
      })
      expect(plan.scope.domains).toEqual(['example.com'])
      expect(plan.stagedWrites.map((cookie) => cookie.name)).toEqual(['session'])
    } finally {
      cleanup()
    }
  })
})

describe('cookie import through the provider seam (#610)', () => {
  const laneKind = 'user_context' as const

  function harness(options: { idle?: boolean; writes?: ImportedCookie[][] } = {}) {
    const lanes = createBrowserLaneRegistry()
    const profileDirectory = mkdtempSync(join(tmpdir(), 'adea-lane-profile-'))
    const service = createCookieImportService()
    const domains: string[] = []
    const { providers } = createBrowserProviders({
      lanes,
      resolveDns: async () => [],
      ownedServices: () => [],
      screenshotRecorder: createScreenshotStore({ scope }),
      cookieImport: {
        service,
        readSource: async () => [
          {
            domain: '.example.com',
            name: 'session',
            value: 'imported-value',
            path: '/',
            secure: true,
            httpOnly: false,
            sameSite: 'lax',
          },
        ],
        targetStore: () => {
          const store = laneStore(profileDirectory)
          if (!options.writes) return store
          return {
            list: () => store.list(),
            remove: (cookies: readonly ImportedCookie[]) => store.remove(cookies),
            write: async (cookies: readonly ImportedCookie[]) => {
              options.writes!.push([...cookies])
              await store.write(cookies)
            },
          }
        },
        assertTargetIdle: () => {
          if (options.idle === false) throw new Error('lane is ready')
        },
      },
    })
    return {
      lanes,
      providers,
      profileDirectory,
      domains,
      cleanup: () => rmSync(profileDirectory, { recursive: true, force: true }),
    }
  }

  function command(
    operation: keyof typeof devOperationDefinitions,
    body: Record<string, unknown>
  ): DevCommand {
    const definition = devOperationDefinitions[operation]
    return {
      schemaVersion: 1,
      operation,
      requestId: '00000000-0000-4000-8000-000000000004',
      nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
      issuedAt: '2026-09-15T12:00:00.000Z',
      expiresAt: '2026-09-15T12:01:00.000Z',
      scope,
      capabilities: definition.capabilities,
      resource: {
        kind: definition.resource!.kind,
        id: String(body[definition.resource!.idField]),
        generation: Number(body.expectedGeneration ?? 1),
      },
      body,
    }
  }

  function laneOf(lanes: ReturnType<typeof createBrowserLaneRegistry>) {
    return lanes.create({
      runtimeSessionId: sessionId,
      kind: laneKind,
      scope,
      profilePolicyId: `default:${laneKind}`,
    })
  }

  test('the preview is a decodable MutationPlan that carries no cookie value', async () => {
    const { lanes, providers, cleanup } = harness()
    try {
      const lane = laneOf(lanes)
      const plan = (await providers['dev.browser.cookieImportPlan']!(
        command('dev.browser.cookieImportPlan', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          sourceProfileId: 'chrome:Test',
          domains: ['example.com'],
        })
      )) as Record<string, unknown>
      // The wire contract's own decoder is the judge of the shape.
      const decoded = decodeDevMutationPlan(plan)
      expect(decoded.operation).toBe('dev.browser.cookieImportCommit')
      expect(decoded.resource).toMatchObject({ kind: 'browser_lane', id: lane.id })
      expect(decoded.factVersions).toMatchObject({
        sourceProfileId: 'chrome:Test',
        domains: 'example.com',
        stagedWrites: '1',
      })
      // Zero secret logging is a property of the reply, not of a log call: a
      // value, or any rendering of one, must not be reachable from it.
      const serialized = JSON.stringify(plan)
      expect(serialized).not.toContain('imported-value')
      expect(serialized).not.toContain('session')
    } finally {
      cleanup()
    }
  })

  test('commit applies the plan to the lane profile and reports the import result', async () => {
    const { lanes, providers, profileDirectory, cleanup } = harness()
    try {
      const lane = laneOf(lanes)
      const plan = (await providers['dev.browser.cookieImportPlan']!(
        command('dev.browser.cookieImportPlan', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          sourceProfileId: 'chrome:Test',
          domains: ['example.com'],
        })
      )) as Record<string, unknown>
      const result = await providers['dev.browser.cookieImportCommit']!(
        command('dev.browser.cookieImportCommit', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          planId: plan.id,
          planDigest: plan.digest,
        })
      )
      expect(result).toMatchObject({ browserLaneId: lane.id, imported: 1, rolledBack: false })
      // The value really is in the profile the lane owns, decrypted by the
      // same store the engine would use.
      const listed = await laneStore(profileDirectory).list()
      expect(listed.map((cookie) => [cookie.name, cookie.value])).toEqual([
        ['session', 'imported-value'],
      ])
    } finally {
      cleanup()
    }
  })

  test('a running lane refuses the commit instead of writing under the engine', async () => {
    const { lanes, providers, cleanup } = harness({ idle: false })
    try {
      const lane = laneOf(lanes)
      const plan = (await providers['dev.browser.cookieImportPlan']!(
        command('dev.browser.cookieImportPlan', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          sourceProfileId: 'chrome:Test',
          domains: ['example.com'],
        })
      )) as Record<string, unknown>
      await expect(
        providers['dev.browser.cookieImportCommit']!(
          command('dev.browser.cookieImportCommit', {
            browserLaneId: lane.id,
            expectedGeneration: lane.generation,
            planId: plan.id,
            planDigest: plan.digest,
          })
        )
      ).rejects.toThrow()
    } finally {
      cleanup()
    }
  })

  test('without the seam the pair stays typed-unavailable', async () => {
    const lanes = createBrowserLaneRegistry()
    const { providers } = createBrowserProviders({
      lanes,
      resolveDns: async () => [],
      ownedServices: () => [],
      screenshotRecorder: createScreenshotStore({ scope }),
    })
    const lane = laneOf(lanes)
    await expect(
      providers['dev.browser.cookieImportPlan']!(
        command('dev.browser.cookieImportPlan', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          sourceProfileId: 'chrome:Test',
          domains: ['example.com'],
        })
      )
    ).rejects.toMatchObject({ code: 'capability_unavailable' })
  })
})
