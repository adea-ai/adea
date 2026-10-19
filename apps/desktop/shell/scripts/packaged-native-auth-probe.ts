// Preparation for a future native (macOS Keychain) auth probe.
//
// This module is the probe's CONTRACT and its BEHAVIOUR, written and tested
// with fake ports. It deliberately contains NO native access of its own: it
// never imports `/usr/bin/security`, never spawns a process, and never
// constructs a system keychain adapter. The only way a probe can reach a
// credential store is through the port a caller injects, and this module
// hands that caller a service name it has already validated.
//
// Why the seam stops here: the wiring that would make a native run possible
// is a six-line call to `createSystemKeychainPort({ service })` in
// `../src/desktop-auth-store`. Writing that wiring into this file would put
// a Keychain-touching path inside the repository's ordinary test discovery.
// Leaving it to a future, explicitly-cleared lane keeps every prepared
// artifact provably inert, and keeps this preparation reviewable without
// anyone holding native-credential clearance.
//
// The future native runner (NOT written here) would be:
//
//   import { createSystemKeychainPort } from '../src/desktop-auth-store'
//   import { runNativeAuthProbe } from './packaged-native-auth-probe'
//   const verdict = runNativeAuthProbe({
//     createPort: (service) => createSystemKeychainPort({ service }),
//     optIn: process.env.ADEA_NATIVE_AUTH_PROBE,
//     service: process.env.ADEA_NATIVE_AUTH_PROBE_SERVICE,
//   })
//
// The four invariants this module enforces, each covered by a fake-port test:
//
//   1. OPT-IN BOUNDARY. The probe refuses unless it is handed the exact
//      opt-in token. A refusal constructs no port and performs no store
//      operation, so a probe that was never authorised cannot touch a
//      credential store even once.
//   2. SERVICE ISOLATION. The service name is required and must be a
//      DISPOSABLE probe service (`com.adea.native-auth-probe.<token>`). The
//      production service `com.adea.desktop` and the Dev Runtime service
//      `com.adea.desktop.dev-runtime` are refused by construction, and the
//      validated service is the one handed to the port factory — a caller
//      cannot point the probe at a production service.
//   3. REDACTED VERDICTS. The verdict is a fixed code plus three counters. It
//      carries no account name, no stored value, no credential, no free-form
//      message, and nothing derived from a store error. The same code is
//      produced for the same outcome on every run, whatever the failure was.
//   4. OWNED-ONLY CLEANUP. The probe deletes only the entries it created, and
//      only while they still hold this run's marker. An account that already
//      held a foreign value is neither written nor deleted, and the verdict
//      counts it. Cleanup also runs when the probe fails part way, so a
//      failed probe leaves behind only what it can prove it owns.
//
// The store it exercises is the production desktop-auth store
// (`../src/desktop-auth-store`), and the port contract is that store's own
// `DesktopAuthKeychainPort`. The values it writes are synthetic, per-run
// markers: no real account, credential, or session is involved.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createDesktopAuthStore,
  DESKTOP_AUTH_ACCOUNTS,
  type DesktopAuthKeychainPort,
} from '../src/desktop-auth-store'

/** The environment variable the future native runner reads for the opt-in. */
export const NATIVE_AUTH_PROBE_OPT_IN_VARIABLE = 'ADEA_NATIVE_AUTH_PROBE'
/** The environment variable the future native runner reads for the service. */
export const NATIVE_AUTH_PROBE_SERVICE_VARIABLE = 'ADEA_NATIVE_AUTH_PROBE_SERVICE'
/** The only opt-in token the probe accepts. */
export const NATIVE_AUTH_PROBE_OPT_IN_VALUE = '1'
/** Every disposable probe service starts with this prefix. */
export const NATIVE_AUTH_PROBE_SERVICE_PREFIX = 'com.adea.native-auth-probe.'

/**
 * Services the probe must never be pointed at. The prefix rule already
 * rejects them; this list states the intent where the intent is clearest.
 */
export const NATIVE_AUTH_PROBE_FORBIDDEN_SERVICES: readonly string[] = [
  'com.adea.desktop',
  'com.adea.desktop.dev-runtime',
  'com.adea.desktop.local-content',
]

/** The fixed outcomes a probe run can report. */
export type NativeAuthProbeCode =
  | 'pass'
  | 'refused_not_opted_in'
  | 'refused_no_service'
  | 'refused_service_not_disposable'
  | 'failed_sentinel_write'
  | 'failed_sentinel_read'
  | 'failed_store_write'
  | 'failed_store_read'
  | 'failed_cleanup'
  | 'failed_probe'

/**
 * The probe's entire report.
 *
 * A fixed code and three counters — nothing else. There is deliberately no
 * field that could carry an account name, a stored value, a credential, a
 * store error's message, or any other free text.
 */
export type NativeAuthProbeVerdict = Readonly<{
  code: NativeAuthProbeCode
  /** Entries this run wrote. */
  created: number
  /** Entries this run deleted during cleanup. */
  cleaned: number
  /**
   * Accounts this run did not delete because the value it found was not the
   * one this run wrote (a pre-existing foreign entry, or an entry whose
   * value changed under the probe).
   */
  skippedNotOwned: number
}>

/** The resolved, validated plan, or the fixed reason there is none. */
export type NativeAuthProbePlan =
  | Readonly<{ ok: true; service: string }>
  | Readonly<{ ok: false; code: NativeAuthProbeCode }>

/**
 * Whether a service name is a DISPOSABLE probe service.
 *
 * Only names under the probe prefix with a token of at least eight
 * lower-case characters qualify. The production services fail the prefix
 * rule, and are refused again by the explicit forbidden list.
 */
export function isDisposableProbeService(service: string): boolean {
  if (NATIVE_AUTH_PROBE_FORBIDDEN_SERVICES.includes(service)) return false
  if (!service.startsWith(NATIVE_AUTH_PROBE_SERVICE_PREFIX)) return false
  return /^[a-z0-9-]{8,}$/u.test(service.slice(NATIVE_AUTH_PROBE_SERVICE_PREFIX.length))
}

/**
 * Resolves the probe's plan, or the fixed reason it has none.
 *
 * The opt-in is checked FIRST, so a probe that was never authorised cannot
 * even learn whether a service name would have been acceptable.
 */
export function resolveNativeAuthProbePlan(input: {
  optIn?: string
  service?: string
}): NativeAuthProbePlan {
  if (input.optIn !== NATIVE_AUTH_PROBE_OPT_IN_VALUE) {
    return { ok: false, code: 'refused_not_opted_in' }
  }
  const service = input.service?.trim()
  if (!service) return { ok: false, code: 'refused_no_service' }
  if (!isDisposableProbeService(service)) {
    return { ok: false, code: 'refused_service_not_disposable' }
  }
  return { ok: true, service }
}

function verdict(
  code: NativeAuthProbeCode,
  counts: { created: number; cleaned: number; skippedNotOwned: number } = {
    created: 0,
    cleaned: 0,
    skippedNotOwned: 0,
  }
): NativeAuthProbeVerdict {
  return Object.freeze({ code, ...counts })
}

/** The synthetic, per-run marker every value this probe writes contains. */
function createRunToken(): string {
  return randomUUID().replace(/-/gu, '')
}

/**
 * The probe.
 *
 * `createPort` is the only path to a credential store, and the probe calls
 * it with the service IT validated — never with a caller's own string.
 */
export function runNativeAuthProbe(options: {
  optIn?: string
  service?: string
  createPort: (service: string) => DesktopAuthKeychainPort
  /** The probe's own data directory; one is created and removed when absent. */
  dataDir?: string
}): NativeAuthProbeVerdict {
  const plan = resolveNativeAuthProbePlan({ optIn: options.optIn, service: options.service })
  if (!plan.ok) return verdict(plan.code)

  const owned = new Set<string>()
  let created = 0
  let cleaned = 0
  let skippedNotOwned = 0

  const token = createRunToken()
  const marker = `native-auth-probe-${token}`
  const sentinelAccount = `native-auth-probe-${token}`

  const ownDataDir = options.dataDir === undefined
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'adea-native-auth-probe-'))

  /** Deletes only this run's entries, and only while they still hold it. */
  function cleanup(port: DesktopAuthKeychainPort): boolean {
    let clean = true
    for (const account of [...owned].toReversed()) {
      let current: string | undefined
      try {
        current = port.get(account)
      } catch {
        clean = false
        continue
      }
      // Only this run's own marker makes an entry ours to delete.
      if (current === undefined || !current.includes(token)) {
        skippedNotOwned += 1
        continue
      }
      try {
        port.delete(account)
        cleaned += 1
      } catch {
        clean = false
      }
    }
    owned.clear()
    return clean
  }

  try {
    mkdirSync(join(dataDir, 'desktop-state'), { recursive: true, mode: 0o700 })
    const port = options.createPort(plan.service)

    // 1. The port itself round-trips, independent of the store's encoding.
    try {
      port.set(sentinelAccount, marker)
    } catch {
      return verdict('failed_sentinel_write', { created, cleaned, skippedNotOwned })
    }
    owned.add(sentinelAccount)
    created += 1
    try {
      if (port.get(sentinelAccount) !== marker) {
        cleanup(port)
        return verdict('failed_sentinel_read', { created, cleaned, skippedNotOwned })
      }
    } catch {
      cleanup(port)
      return verdict('failed_sentinel_read', { created, cleaned, skippedNotOwned })
    }

    // 2. The production desktop-auth store's own three entries, over the
    //    same port, with synthetic values carrying this run's marker.
    const store = createDesktopAuthStore({ dataDir, port })
    const attempt = {
      codeChallenge: token + token,
      codeVerifier: token + token,
      expiresAt: 1_900_000_000_000,
      nonce: token,
      redirectUri: 'adea://auth/callback' as const,
      state: token,
      used: false,
    }
    const session = {
      credential: token + token,
      expiresAt: new Date(1_900_000_000_000).toISOString(),
      sessionId: '11111111-1111-4111-8111-111111111111',
    }
    const temporaryCredential = `adea_tmp_${(token + token).slice(0, 43)}`

    const entries: readonly {
      account: string
      write: () => void
      read: () => unknown
    }[] = [
      {
        account: DESKTOP_AUTH_ACCOUNTS.authorizationAttempt,
        write: () => store.saveAuthorizationAttempt(attempt),
        read: () => store.loadAuthorizationAttempt(),
      },
      {
        account: DESKTOP_AUTH_ACCOUNTS.userSession,
        write: () => store.saveUserSession(session),
        read: () => store.loadUserSession(),
      },
      {
        account: DESKTOP_AUTH_ACCOUNTS.temporaryWorkspace,
        write: () => store.saveTemporaryWorkspaceCredential(temporaryCredential),
        read: () => store.loadTemporaryWorkspaceCredential(),
      },
    ]

    for (const entry of entries) {
      // An account that already holds a foreign value is left exactly as it
      // is: this run neither writes nor deletes it.
      let existing: string | undefined
      try {
        existing = port.get(entry.account)
      } catch {
        cleanup(port)
        return verdict('failed_store_read', { created, cleaned, skippedNotOwned })
      }
      if (existing !== undefined && !existing.includes(token)) {
        skippedNotOwned += 1
        continue
      }
      try {
        entry.write()
      } catch {
        cleanup(port)
        return verdict('failed_store_write', { created, cleaned, skippedNotOwned })
      }
      owned.add(entry.account)
      created += 1
      try {
        const loaded = entry.read()
        if (loaded === null || loaded === undefined) {
          cleanup(port)
          return verdict('failed_store_read', { created, cleaned, skippedNotOwned })
        }
      } catch {
        cleanup(port)
        return verdict('failed_store_read', { created, cleaned, skippedNotOwned })
      }
    }

    // 3. Cleanup, owned-only, on the success path too.
    if (!cleanup(port)) {
      return verdict('failed_cleanup', { created, cleaned, skippedNotOwned })
    }
    return verdict('pass', { created, cleaned, skippedNotOwned })
  } catch {
    // The catch-all. The error itself is deliberately dropped: the verdict
    // may not carry a store message, a path, or a value.
    return verdict('failed_probe', { created, cleaned, skippedNotOwned })
  } finally {
    if (ownDataDir) rmSync(dataDir, { recursive: true, force: true })
  }
}
