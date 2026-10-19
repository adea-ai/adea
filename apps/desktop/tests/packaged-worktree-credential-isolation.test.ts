// The packaged worktree containment lane must not reach the operating
// system's credential store.
//
// The lane proved CONTAINMENT — that the production registrar refuses a
// worktree, a template, or an include-copy that escapes its authorized root
// — but it built its credential vault with `createCredentialVault` and no
// `credentialStore`, so the vault fell through to
// `createSystemVaultKeyStore()` and shelled out to `/usr/bin/security`. On a
// machine where that call cannot complete, the lane failed with
// `the OS credential store refused: the OS credential store did not answer in
// time` — a Keychain timeout that looked like a broken containment lane and
// lost every containment proof.
//
// These tests pin the repair:
//
//   1. the lane's source names no native credential backend, and builds its
//      vault through the isolated factory;
//   2. at runtime, the lane's vault performs every store operation against
//      the INJECTED store — the vault key is created there and read back
//      from there — so the native backend is not merely unused but
//      unreachable;
//   3. the containment proofs the lane exists to deliver are still there.
//
// The lane's own execution is NOT run here: it needs a packaged bundle and
// spawns real processes. This is a source-and-seam proof, not a lane run.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createOwnerApprovalVerifier,
  type OwnerApprovalVerifier,
} from '../shell/src/dev-runtime/authority'
import { createLaneCredentialVault } from '../shell/scripts/packaged-worktree-smoke'
import type { VaultKeyStore } from '../shell/src/dev-runtime/vault'

const lanePath = new URL('../shell/scripts/packaged-worktree-smoke.ts', import.meta.url).pathname
const vaultPath = new URL('../shell/src/dev-runtime/vault.ts', import.meta.url).pathname

const laneSource = readFileSync(lanePath, 'utf8')

/**
 * The lane's source with comments removed.
 *
 * The lane's own prose names the backend it refuses to use, so an absence
 * assertion made against the raw source would be satisfied by the comment
 * rather than by the code. String literals are preserved verbatim, so a `//`
 * inside a URL is not mistaken for a comment.
 */
function codeOnly(source: string): string {
  let out = ''
  let index = 0
  while (index < source.length) {
    const rest = source.slice(index)
    if (rest.startsWith('//')) {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end
      continue
    }
    if (rest.startsWith('/*')) {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    const quote = source[index]
    if (quote === "'" || quote === '"' || quote === '`') {
      out += quote
      index += 1
      while (index < source.length) {
        const character = source[index]
        out += character
        index += 1
        if (character === '\\') {
          if (index < source.length) {
            out += source[index]
            index += 1
          }
          continue
        }
        if (character === quote) break
      }
      continue
    }
    out += source[index]
    index += 1
  }
  return out
}

const laneCode = codeOnly(laneSource)

/** A store that records every operation, so a test can see what was asked. */
function recordingStore(): VaultKeyStore & {
  calls: { op: string; service: string; account: string }[]
} {
  const keys = new Map<string, Buffer>()
  const calls: { op: string; service: string; account: string }[] = []
  const key = (service: string, account: string) => `${service}\u0000${account}`
  return {
    calls,
    delete: (service, account) => {
      calls.push({ op: 'delete', service, account })
      void keys.delete(key(service, account))
    },
    get: (service, account) => {
      calls.push({ op: 'get', service, account })
      return keys.get(key(service, account))
    },
    set: (service, account, value) => {
      calls.push({ op: 'set', service, account })
      keys.set(key(service, account), Buffer.from(value))
    },
  }
}

function withDataDir(body: (dataDir: string, verifier: OwnerApprovalVerifier) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-lane-credential-isolation-'))
  try {
    body(dataDir, createOwnerApprovalVerifier({ dataDir }))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

describe('the packaged containment lane names no native credential backend', () => {
  test('the lane never reaches the OS credential store', () => {
    // The native backends the vault can fall back to: the macOS `security`
    // CLI adapter and Bun's native secret slot. The scan runs over the
    // lane's CODE, so the lane's own prose about them does not satisfy it.
    expect(laneCode).not.toContain('createSystemVaultKeyStore')
    expect(laneCode).not.toContain('/usr/bin/security')
    expect(laneCode).not.toContain('Bun.secrets')
    expect(laneCode).not.toContain('createBunSecretsVaultKeyStore')
    // The scan is meaningful: the lane's own comment DOES name the backend
    // it refuses, so a raw-source scan would have found it.
    expect(laneSource).toContain('createSystemVaultKeyStore')
  })

  test('every vault the lane builds is given an explicit store', () => {
    // The production vault falls back to the system keychain when no store
    // is supplied, and that fallback is exactly what the lane must never
    // reach. So every `createCredentialVault` call in the lane must name a
    // `credentialStore` — this is the assertion that catches the pre-repair
    // call site, which named no native backend itself yet still reached one.
    const vaultCalls = [...laneCode.matchAll(/createCredentialVault\s*\(\s*\{([^}]*)\}/g)]
    expect(vaultCalls.length).toBeGreaterThan(0)
    for (const call of vaultCalls) {
      expect(call[1]).toContain('credentialStore')
    }
  })

  test('the lane builds its vault through the isolated factory', () => {
    expect(laneCode).toContain('createLaneCredentialVault')
    // The factory's default backend is the in-memory store, never the system
    // one, and the store is passed explicitly so the vault's
    // `options.credentialStore ?? createSystemVaultKeyStore()` fallback can
    // never be reached from this path.
    expect(laneCode).toContain('createInMemoryVaultKeyStore()')
    expect(laneCode).toContain(
      'credentialStore: options.credentialStore ?? createInMemoryVaultKeyStore()'
    )
    // The lane's call site passes no store of its own, so it takes the
    // isolated default.
    expect(laneCode).toContain(
      'const vault = createLaneCredentialVault({ dataDir, approvalVerifier: verifier })'
    )
  })

  test('the production vault still reaches the native backend when nothing is injected', () => {
    // The repair is local to the lane: the production vault keeps its system
    // keychain backend, and the true-keychain packaged lane is unchanged.
    const vaultSource = readFileSync(vaultPath, 'utf8')
    expect(vaultSource).toContain(
      'const vaultKeyStore = options.credentialStore ?? createSystemVaultKeyStore()'
    )
    expect(existsSync(vaultPath)).toBe(true)
  })
})

describe("the lane's vault is served entirely by the injected store", () => {
  test('the vault key is created in, and read back from, the injected store', () => {
    withDataDir((dataDir, verifier) => {
      const store = recordingStore()
      const vault = createLaneCredentialVault({
        dataDir,
        approvalVerifier: verifier,
        credentialStore: store,
      })

      // Creating the vault generates the vault key, because the injected
      // store had none. That generation is the operation that used to reach
      // `/usr/bin/security`.
      expect(typeof vault.enroll).toBe('function')
      expect(typeof vault.resolve).toBe('function')
      const keyWrites = store.calls.filter((call) => call.op === 'set')
      expect(keyWrites.length).toBeGreaterThan(0)
      expect(keyWrites[0]?.service).toBe('com.adea.desktop.dev-runtime')
      expect(keyWrites[0]?.account).toBe('master-key-v1')

      // Every operation the vault performed went to the injected store.
      for (const call of store.calls) {
        expect(call.service).toBe('com.adea.desktop.dev-runtime')
        expect(call.account).toBe('master-key-v1')
      }
      // Nothing was deleted, and nothing was read that the store had not
      // been given: the key generation is a miss-then-set, nothing more.
      expect(store.calls.filter((call) => call.op === 'delete')).toHaveLength(0)
      expect(store.calls.map((call) => call.op)).toEqual(['get', 'set'])
    })
  })

  test("the lane's default store also satisfies the vault contract", () => {
    // The default is the production in-memory store. The vault must be
    // fully usable through it, so the lane's own credential path works with
    // no native backend present.
    withDataDir((dataDir, verifier) => {
      const vault = createLaneCredentialVault({ dataDir, approvalVerifier: verifier })
      expect(typeof vault.enroll).toBe('function')
      expect(typeof vault.resolve).toBe('function')
    })
  })
})

describe('the containment proofs the lane exists to deliver are preserved', () => {
  test('the escape refusals and their assertions are still in the lane', () => {
    for (const marker of [
      'PROOF 1 dev.worktree.create through the production registrar',
      'PROOF 2 dependency-template materialization into a registrar-created worktree',
      'PROOF 3 digest-tamper refusal after promotion',
      'PROOF 4 registrar generation fencing on dev.worktree.lease',
      'PROOF 5 create → bootstrap → merge-back → complete-and-clean',
      'PROOF 6 .worktreeinclude symlink escape refusal',
    ]) {
      expect(laneSource).toContain(marker)
    }
  })

  test('the containment refusals keep their typed codes and untouched-target check', () => {
    // The include-copy escape must still be refused with its typed code, and
    // the escape target must still be proven untouched.
    expect(laneSource).toContain('symlink_rejected')
    expect(laneSource).toContain('include-copy escape target was untouched')
    // The template tamper must still be refused with its typed code.
    expect(laneSource).toContain('identity_mismatch')
    // The stale-generation fence must still refuse a stale envelope.
    expect(laneSource).toContain('stale_generation')
  })

  test('the lane still reports its containment verdict', () => {
    expect(laneSource).toContain('PACKAGED-WORKTREE-CONTAINMENT PASS')
    expect(laneSource).toContain('PACKAGED-WORKTREE-CONTAINMENT FAILED')
  })
})
