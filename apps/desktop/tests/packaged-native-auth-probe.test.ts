// The native-auth probe's contract, proved with fake ports only.
//
// Nothing here reaches a credential store: the probe takes its port from an
// injected factory, and these tests inject a recording fake. No `/usr/bin/
// security`, no Keychain API, no real account, no credential, and no app is
// involved, and none of it happens as a side effect of ordinary test
// discovery.
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isDisposableProbeService,
  NATIVE_AUTH_PROBE_FORBIDDEN_SERVICES,
  NATIVE_AUTH_PROBE_OPT_IN_VALUE,
  NATIVE_AUTH_PROBE_SERVICE_PREFIX,
  runNativeAuthProbe,
  type NativeAuthProbeCode,
} from '../shell/scripts/packaged-native-auth-probe'
import {
  DESKTOP_AUTH_ACCOUNTS,
  type DesktopAuthKeychainPort,
} from '../shell/src/desktop-auth-store'

const probeSource = readFileSync(
  new URL('../shell/scripts/packaged-native-auth-probe.ts', import.meta.url).pathname,
  'utf8'
)

/**
 * The probe's source with comments removed, so an absence assertion is about
 * CODE, not about the module's prose describing what it deliberately avoids.
 * String literals are preserved verbatim.
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

const probeCode = codeOnly(probeSource)

const VALID_SERVICE = `${NATIVE_AUTH_PROBE_SERVICE_PREFIX}0123456789abcdef`

type Call = { op: 'get' | 'set' | 'delete'; account: string }

/** A recording fake port. It is a plain map: no durability, no native path. */
function createFakePort(seed: Readonly<Record<string, string>> = {}) {
  const values = new Map<string, string>(Object.entries(seed))
  const calls: Call[] = []
  const writes: { account: string; value: string }[] = []
  const failures = { set: undefined as string | undefined, get: undefined, delete: undefined }
  const port: DesktopAuthKeychainPort = {
    delete: (account) => {
      calls.push({ op: 'delete', account })
      if (failures.delete === account) throw new Error('fake delete refused')
      values.delete(account)
    },
    get: (account) => {
      calls.push({ op: 'get', account })
      if (failures.get === account) throw new Error('fake get refused')
      return values.get(account)
    },
    set: (account, value) => {
      calls.push({ op: 'set', account })
      writes.push({ account, value })
      if (failures.set === account) throw new Error('fake set refused')
      values.set(account, value)
    },
  }
  return { calls, failures, port, values, writes }
}

/** A factory that records the service it was handed, and how often. */
function createFactory(port: DesktopAuthKeychainPort) {
  const services: string[] = []
  return {
    createPort: (service: string) => {
      services.push(service)
      return port
    },
    services,
  }
}

const VERDICT_KEYS = ['cleaned', 'code', 'created', 'skippedNotOwned']

describe('the native-auth probe refuses without an explicit opt-in', () => {
  test('no opt-in constructs no port and performs no store operation', () => {
    const fake = createFakePort()
    const factory = createFactory(fake.port)

    const verdict = runNativeAuthProbe({
      createPort: factory.createPort,
      optIn: undefined,
      service: VALID_SERVICE,
    })

    expect(verdict.code).toBe('refused_not_opted_in')
    expect(factory.services).toEqual([])
    expect(fake.calls).toEqual([])
  })

  test('only the exact opt-in token is accepted', () => {
    for (const optIn of ['', '0', 'true', 'yes', 'ADEA_NATIVE_AUTH_PROBE', '1 ']) {
      const fake = createFakePort()
      const factory = createFactory(fake.port)
      const verdict = runNativeAuthProbe({
        createPort: factory.createPort,
        optIn,
        service: VALID_SERVICE,
      })
      expect(verdict.code).toBe('refused_not_opted_in')
      expect(factory.services).toEqual([])
    }
  })

  test('the opt-in with a disposable service reaches the port factory', () => {
    const fake = createFakePort()
    const factory = createFactory(fake.port)
    const verdict = runNativeAuthProbe({
      createPort: factory.createPort,
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: VALID_SERVICE,
    })
    expect(factory.services).toEqual([VALID_SERVICE])
    expect(verdict.code).toBe('pass')
  })
})

describe('the native-auth probe refuses any non-disposable service', () => {
  test('a missing service is refused before the port factory is called', () => {
    const fake = createFakePort()
    const factory = createFactory(fake.port)
    const verdict = runNativeAuthProbe({
      createPort: factory.createPort,
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: undefined,
    })
    expect(verdict.code).toBe('refused_no_service')
    expect(factory.services).toEqual([])
  })

  test('the production services are refused', () => {
    for (const service of NATIVE_AUTH_PROBE_FORBIDDEN_SERVICES) {
      expect(isDisposableProbeService(service)).toBe(false)
      const fake = createFakePort()
      const factory = createFactory(fake.port)
      const verdict = runNativeAuthProbe({
        createPort: factory.createPort,
        optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
        service,
      })
      expect(verdict.code).toBe('refused_service_not_disposable')
      expect(factory.services).toEqual([])
      expect(fake.calls).toEqual([])
    }
  })

  test('only a probe-prefixed service with a long enough token qualifies', () => {
    for (const service of [
      'com.adea.desktop',
      'com.adea.desktop.dev-runtime',
      'com.adea.native-auth-probe',
      `${NATIVE_AUTH_PROBE_SERVICE_PREFIX}short`,
      `${NATIVE_AUTH_PROBE_SERVICE_PREFIX}UPPERCASE`,
      'com.adea.native-auth-probe.0123456789abcdef/../..',
      'some.other.service.0123456789abcdef',
    ]) {
      expect(isDisposableProbeService(service)).toBe(false)
    }
    expect(isDisposableProbeService(VALID_SERVICE)).toBe(true)
  })
})

describe('the native-auth probe verdict is fixed and redacted', () => {
  test('the verdict carries a fixed code and counters, and nothing else', () => {
    const fake = createFakePort()
    const verdict = runNativeAuthProbe({
      createPort: createFactory(fake.port).createPort,
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: VALID_SERVICE,
    })

    expect(Object.keys(verdict).toSorted()).toEqual(VERDICT_KEYS)
    for (const value of Object.values(verdict)) {
      expect(typeof value === 'string' || typeof value === 'number').toBe(true)
    }
    // Every field is a number except the fixed code.
    expect(typeof verdict.created).toBe('number')
    expect(typeof verdict.cleaned).toBe('number')
    expect(typeof verdict.skippedNotOwned).toBe('number')
  })

  test('the verdict exposes no account name, marker, credential, or token', () => {
    const fake = createFakePort()
    const verdict = runNativeAuthProbe({
      createPort: createFactory(fake.port).createPort,
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: VALID_SERVICE,
    })

    // The marker this run wrote is the sentinel's value; the token is the
    // run-unique part of it. It is read from the write log, because the
    // probe has already deleted the entry by the time it returns.
    const sentinelWrite = fake.writes[0]
    expect(sentinelWrite?.account.startsWith('native-auth-probe-')).toBe(true)
    const marker = sentinelWrite?.value ?? ''
    const token = marker.replace('native-auth-probe-', '')

    const serialized = JSON.stringify(verdict)
    expect(token.length).toBeGreaterThan(8)
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain(marker)
    expect(serialized).not.toContain(sentinelWrite?.account ?? 'x')
    for (const account of Object.values(DESKTOP_AUTH_ACCOUNTS)) {
      expect(serialized).not.toContain(account)
    }
    expect(serialized).not.toContain(VALID_SERVICE)
  })

  test('a store failure is reported as a fixed code, never as its message', () => {
    const fake = createFakePort()
    fake.failures.get = DESKTOP_AUTH_ACCOUNTS.userSession
    const verdict = runNativeAuthProbe({
      createPort: createFactory(fake.port).createPort,
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: VALID_SERVICE,
    })

    expect(verdict.code).toBe('failed_store_read')
    const serialized = JSON.stringify(verdict)
    expect(serialized).not.toContain('fake get refused')
    expect(serialized).not.toContain('Error')
    // The shape is the same as a successful verdict.
    expect(Object.keys(verdict).toSorted()).toEqual(VERDICT_KEYS)
  })

  test('the same outcome always yields the same code', () => {
    const codes = new Set<string>()
    for (let run = 0; run < 3; run += 1) {
      const fake = createFakePort()
      const verdict = runNativeAuthProbe({
        createPort: createFactory(fake.port).createPort,
        optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
        service: VALID_SERVICE,
      })
      codes.add(verdict.code)
    }
    expect([...codes]).toEqual(['pass'])
  })
})

describe('the native-auth probe cleans up only what it owns', () => {
  test('a foreign entry is neither written nor deleted', () => {
    const foreign = JSON.stringify({ foreign: true, note: 'not the probe’s value' })
    const fake = createFakePort({ [DESKTOP_AUTH_ACCOUNTS.userSession]: foreign })
    const verdict = runNativeAuthProbe({
      createPort: createFactory(fake.port).createPort,
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: VALID_SERVICE,
    })

    expect(verdict.code).toBe('pass')
    expect(verdict.skippedNotOwned).toBe(1)
    // The foreign value survives untouched.
    expect(fake.values.get(DESKTOP_AUTH_ACCOUNTS.userSession)).toBe(foreign)
    // The probe never wrote it.
    const writes = fake.calls.filter(
      (call) => call.op === 'set' && call.account === DESKTOP_AUTH_ACCOUNTS.userSession
    )
    expect(writes).toEqual([])
  })

  test('every entry this run created is deleted again', () => {
    const fake = createFakePort()
    const verdict = runNativeAuthProbe({
      createPort: createFactory(fake.port).createPort,
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: VALID_SERVICE,
    })

    expect(verdict.code).toBe('pass')
    expect(verdict.created).toBe(4)
    expect(verdict.cleaned).toBe(4)
    expect(verdict.skippedNotOwned).toBe(0)
    // Nothing this run wrote is left behind.
    expect([...fake.values.keys()]).toEqual([])
    // And every delete it issued was for an account it had written.
    const written = new Set(fake.calls.filter((call) => call.op === 'set').map((c) => c.account))
    for (const call of fake.calls.filter((c) => c.op === 'delete')) {
      expect(written.has(call.account)).toBe(true)
    }
  })

  test('an account whose value changed under the probe is not deleted', () => {
    const fake = createFakePort()
    const port = fake.port
    const sentinelReads = new Map<string, number>()
    const verdict = runNativeAuthProbe({
      createPort: (_service) => ({
        delete: (account) => port.delete(account),
        get: (account) => {
          // The probe reads the sentinel once to confirm the write, and once
          // more during cleanup. Rewriting the value between those two
          // reads is exactly "someone else took the entry".
          if (account.startsWith('native-auth-probe-')) {
            const count = (sentinelReads.get(account) ?? 0) + 1
            sentinelReads.set(account, count)
            if (count >= 2) port.set(account, 'someone-else')
          }
          return port.get(account)
        },
        set: (account, value) => port.set(account, value),
      }),
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: VALID_SERVICE,
    })

    expect(verdict.code).toBe('pass')
    expect(verdict.skippedNotOwned).toBeGreaterThanOrEqual(1)
    // The rewritten value is still there: the probe did not delete it.
    expect([...fake.values.values()]).toContain('someone-else')
  })
})

describe('the native-auth probe cleans up after a failure', () => {
  test('a failed store write still removes what the run had created', () => {
    const fake = createFakePort()
    fake.failures.set = DESKTOP_AUTH_ACCOUNTS.authorizationAttempt
    const verdict = runNativeAuthProbe({
      createPort: createFactory(fake.port).createPort,
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: VALID_SERVICE,
    })

    expect(verdict.code).toBe('failed_store_write')
    // The sentinel was written before the failure and is removed again.
    expect(verdict.created).toBe(1)
    expect(verdict.cleaned).toBe(1)
    expect([...fake.values.keys()]).toEqual([])
  })

  test('a failure during cleanup is reported as a fixed code', () => {
    const fake = createFakePort()
    const verdict = runNativeAuthProbe({
      createPort: (_service) => {
        const port = fake.port
        return {
          delete: (account) => {
            if (account.startsWith('native-auth-probe-')) throw new Error('cleanup refused')
            port.delete(account)
          },
          get: (account) => port.get(account),
          set: (account, value) => port.set(account, value),
        }
      },
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: VALID_SERVICE,
    })

    expect(verdict.code).toBe('failed_cleanup')
    expect(JSON.stringify(verdict)).not.toContain('cleanup refused')
  })

  test('a failure never reports a pass', () => {
    const codes: NativeAuthProbeCode[] = []
    for (const failure of ['set', 'get', 'delete'] as const) {
      const fake = createFakePort()
      fake.failures[failure] = DESKTOP_AUTH_ACCOUNTS.userSession
      const verdict = runNativeAuthProbe({
        createPort: createFactory(fake.port).createPort,
        optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
        service: VALID_SERVICE,
      })
      codes.push(verdict.code)
    }
    expect(codes).not.toContain('pass')
  })
})

describe('ordinary test discovery has no native side effects', () => {
  test('the probe module contains no native credential path of its own', () => {
    // The probe reaches a credential store ONLY through the port a caller
    // injects. It never names the macOS CLI, never spawns a process, and
    // never constructs the system adapter. The scan runs over the module's
    // CODE, so the prose describing what it avoids cannot satisfy it.
    for (const forbidden of [
      '/usr/bin/security',
      'execFileSync',
      'spawnSync',
      'Bun.secrets',
      'createSystemKeychainPort',
      'createSystemVaultKeyStore',
    ]) {
      expect(probeCode).not.toContain(forbidden)
    }
    // The prose does name them, so the scan is meaningful rather than
    // vacuously true.
    expect(probeSource).toContain('/usr/bin/security')
  })

  test('the probe module has no entry point of its own', () => {
    // It is a library: importing it cannot run a probe, so a test file that
    // imports it has no side effect at all.
    expect(probeCode).not.toContain('process.argv')
    expect(probeCode).not.toContain('process.exit')
    expect(probeCode).not.toContain('import.meta.main')
  })

  test('a refused probe never reaches the store', () => {
    const fake = createFakePort()
    const verdict = runNativeAuthProbe({
      createPort: createFactory(fake.port).createPort,
      optIn: undefined,
      service: VALID_SERVICE,
    })
    expect(verdict.code).toBe('refused_not_opted_in')
    expect(fake.calls).toEqual([])
  })

  test('the probe removes the data directory it created, and only that one', () => {
    const probeDirectories = () =>
      readdirSync(tmpdir()).filter((entry) => entry.startsWith('adea-native-auth-probe-'))

    const before = probeDirectories()
    const verdict = runNativeAuthProbe({
      createPort: createFactory(createFakePort().port).createPort,
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: VALID_SERVICE,
    })
    expect(verdict.code).toBe('pass')
    // Its own temporary directory is gone.
    expect(probeDirectories()).toEqual(before)

    // A caller-provided directory is never removed, and the store's state
    // directory inside it is left for the caller to inspect.
    const provided = join(tmpdir(), `adea-native-auth-probe-provided-${Date.now()}`)
    const providedVerdict = runNativeAuthProbe({
      createPort: createFactory(createFakePort().port).createPort,
      dataDir: provided,
      optIn: NATIVE_AUTH_PROBE_OPT_IN_VALUE,
      service: VALID_SERVICE,
    })
    expect(providedVerdict.code).toBe('pass')
    expect(existsSync(join(provided, 'desktop-state'))).toBe(true)
    rmSync(provided, { force: true, recursive: true })
  })
})
