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
// The future native runner (NOT written here) would construct the system
// adapter for the service the probe validated and hand it to the probe as
// its port factory; the probe then calls that factory with the service IT
// validated, never with a caller's own string.
//
// The invariants this module enforces, each covered by a fake-port test:
//
//   1. OPT-IN BOUNDARY. The probe refuses unless it is handed the exact
//      opt-in token. A refusal constructs no port and performs no store
//      operation, so a probe that was never authorised cannot touch a
//      credential store even once.
//   2. SERVICE ISOLATION. The service name is required and must be a
//      DISPOSABLE probe service (`com.adea.native-auth-probe.<token>`). The
//      production services are refused by construction.
//   3. INTENDED OWNERSHIP. An entry is recorded as this run's BEFORE the
//      write is attempted, so a write that COMMITS and then throws — a
//      timeout, a refused call that landed anyway — is still owned, and is
//      still cleaned up. Tracking ownership only on a successful return
//      would leave exactly those entries behind.
//   4. UNCONDITIONAL CLEANUP. Cleanup runs on every path: success, every
//      failure, and the catch-all. It is guarded, so a cleanup problem can
//      never mask the outcome, and a cleanup failure is reported even when
//      something else already failed — leftover entries in a credential store
//      are the more serious condition.
//   5. EXACT COMPARISON. An entry is this run's only while the stored value
//      is EXACTLY the value this run wrote, not merely a value that happens
//      to contain this run's marker. A round trip is proved by comparing
//      every decoded record to its expected synthetic value: a decoded
//      non-null value is not a proof, and a stale or corrupted-but-valid
//      record must fail.
//   6. DELETION IS VERIFIED. A delete that does not actually remove the
//      entry is a cleanup FAILURE, not a cleanup success.
//   7. NO FALSE GREEN. A pre-existing foreign auth slot is preserved, never
//      written and never deleted — and because that required check did not
//      run, the probe reports an explicit incomplete outcome rather than a
//      pass. A probe that skipped every slot has proved nothing.
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
  encodeDesktopAuthorizationAttempt,
  encodeDesktopSession,
  encodeTemporaryWorkspaceCredential,
} from '@adea-ai/auth/desktop'

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
  | 'incomplete_foreign_slots'
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
  /**
   * Entries this run INTENDED to create. The intent is recorded before the
   * write, so an entry whose write committed and then threw is counted here
   * and is cleaned up.
   */
  created: number
  /** Entries this run deleted during cleanup, and then verified were gone. */
  cleaned: number
  /**
   * Accounts this run did not delete because the value it found was not the
   * exact value this run wrote (a pre-existing foreign entry, or an entry
   * whose value changed under the probe).
   */
  skippedNotOwned: number
}>

/** The resolved, validated plan, or the fixed reason there is none. */
export type NativeAuthProbePlan =
  | Readonly<{ ok: true; service: string }>
  | Readonly<{ ok: false; code: NativeAuthProbeCode }>

/** An entry this run intended to create, with the exact value it must hold. */
type OwnedEntry = Readonly<{ account: string; expected: string }>

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

/** Structural equality, so a decoded record can be compared to its source. */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).toSorted()
  const rightKeys = Object.keys(rightRecord).toSorted()
  if (leftKeys.length !== rightKeys.length) return false
  if (leftKeys.some((key, index) => key !== rightKeys[index])) return false
  return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]))
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

  const owned: OwnedEntry[] = []
  const state = { created: 0, cleaned: 0, skippedNotOwned: 0 }
  const token = createRunToken()
  const marker = `native-auth-probe-${token}`
  const sentinelAccount = `native-auth-probe-${token}`
  const ownDataDir = options.dataDir === undefined
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'adea-native-auth-probe-'))

  let port: DesktopAuthKeychainPort | undefined
  let code: NativeAuthProbeCode = 'failed_probe'

  /**
   * Deletes only the entries this run intended to create, and only while
   * they still hold the EXACT value this run wrote. A delete that does not
   * remove the entry is a cleanup failure, not a cleanup success.
   */
  function cleanup(): boolean {
    if (!port) return true
    let clean = true
    for (const entry of [...owned].toReversed()) {
      let current: string | undefined
      try {
        current = port.get(entry.account)
      } catch {
        clean = false
        continue
      }
      if (current === undefined) {
        // Already gone: this run did not delete it.
        state.skippedNotOwned += 1
        continue
      }
      if (current !== entry.expected) {
        // Someone else's value: not ours to delete.
        state.skippedNotOwned += 1
        continue
      }
      try {
        port.delete(entry.account)
      } catch {
        clean = false
        continue
      }
      // The delete must actually have removed the entry.
      let after: string | undefined
      try {
        after = port.get(entry.account)
      } catch {
        clean = false
        continue
      }
      if (after !== undefined) {
        clean = false
        continue
      }
      state.cleaned += 1
    }
    owned.length = 0
    return clean
  }

  function attempt(service: string): NativeAuthProbeCode {
    mkdirSync(join(dataDir, 'desktop-state'), { recursive: true, mode: 0o700 })
    port = options.createPort(service)

    // 1. The port itself round-trips, independent of the store's encoding.
    //    The intent to own the entry is recorded BEFORE the write: a write
    //    that commits and then throws is still ours to clean up.
    owned.push({ account: sentinelAccount, expected: marker })
    state.created += 1
    try {
      port.set(sentinelAccount, marker)
    } catch {
      return 'failed_sentinel_write'
    }
    let sentinelValue: string | undefined
    try {
      sentinelValue = port.get(sentinelAccount)
    } catch {
      return 'failed_sentinel_read'
    }
    if (sentinelValue !== marker) return 'failed_sentinel_read'

    // 2. The production desktop-auth store's own three entries, over the
    //    same port, with synthetic values carrying this run's marker.
    const store = createDesktopAuthStore({ dataDir, port })
    const attemptValue = {
      codeChallenge: token + token,
      codeVerifier: token + token,
      expiresAt: 1_900_000_000_000,
      nonce: token,
      redirectUri: 'adea://auth/callback' as const,
      state: token,
      used: false,
    }
    const sessionValue = {
      credential: token + token,
      expiresAt: new Date(1_900_000_000_000).toISOString(),
      sessionId: '11111111-1111-4111-8111-111111111111',
    }
    const temporaryValue = `adea_tmp_${(token + token).slice(0, 43)}`

    const slots: readonly {
      account: string
      /** The exact encoded value a successful write must leave behind. */
      expected: string
      /** The exact decoded value a successful read must return. */
      decoded: unknown
      write: () => void
      read: () => unknown
    }[] = [
      {
        account: DESKTOP_AUTH_ACCOUNTS.authorizationAttempt,
        decoded: attemptValue,
        expected: encodeDesktopAuthorizationAttempt(attemptValue),
        read: () => store.loadAuthorizationAttempt(),
        write: () => store.saveAuthorizationAttempt(attemptValue),
      },
      {
        account: DESKTOP_AUTH_ACCOUNTS.userSession,
        decoded: sessionValue,
        expected: encodeDesktopSession(sessionValue),
        read: () => store.loadUserSession(),
        write: () => store.saveUserSession(sessionValue),
      },
      {
        account: DESKTOP_AUTH_ACCOUNTS.temporaryWorkspace,
        decoded: temporaryValue,
        expected: encodeTemporaryWorkspaceCredential(temporaryValue),
        read: () => store.loadTemporaryWorkspaceCredential(),
        write: () => store.saveTemporaryWorkspaceCredential(temporaryValue),
      },
    ]

    let skippedSlot = false
    for (const slot of slots) {
      // An account that already holds a foreign value is left exactly as it
      // is: this run neither writes nor deletes it — and because that
      // required check did not run, the probe is not complete.
      let existing: string | undefined
      try {
        existing = port.get(slot.account)
      } catch {
        return 'failed_store_read'
      }
      if (existing !== undefined && existing !== slot.expected) {
        state.skippedNotOwned += 1
        skippedSlot = true
        continue
      }
      owned.push({ account: slot.account, expected: slot.expected })
      state.created += 1
      try {
        slot.write()
      } catch {
        return 'failed_store_write'
      }
      let loaded: unknown
      try {
        loaded = slot.read()
      } catch {
        return 'failed_store_read'
      }
      // A decoded non-null value is not a round-trip proof: the record must
      // equal the synthetic value this run wrote.
      if (!deepEqual(loaded, slot.decoded)) return 'failed_store_read'
    }
    return skippedSlot ? 'incomplete_foreign_slots' : 'pass'
  }

  try {
    code = attempt(plan.service)
  } catch {
    // The catch-all. The error itself is deliberately dropped: the verdict
    // may not carry a store message, a path, or a value.
    code = 'failed_probe'
  } finally {
    // Cleanup is unconditional and guarded. It runs on the success path, on
    // every failure path, and on the catch-all; and a cleanup failure is
    // reported even when something else already failed, because a leftover
    // entry in a credential store is the more serious condition.
    if (port && !cleanup()) code = 'failed_cleanup'
    if (ownDataDir) rmSync(dataDir, { recursive: true, force: true })
  }

  return verdict(code, state)
}
