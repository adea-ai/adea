/*
 * The system keychain port's SERVICE OVERRIDE.
 *
 * `createSystemKeychainPort({ service })` is the one seam a future native
 * runner depends on. The prepared native-auth probe
 * (`apps/desktop/shell/scripts/packaged-native-auth-probe.ts`, merged in
 * #1497) refuses every production service and only accepts a DISPOSABLE probe
 * service, and it documents the wiring a cleared native lane would use as a
 * six-line call to `createSystemKeychainPort({ service })`. The probe is
 * inert by construction: it never touches a credential store itself.
 *
 * That makes the override load-bearing. If the port ignored a caller's
 * service and fell back to the canonical `com.adea.desktop`, a native runner
 * that believed it was writing to a disposable probe service would instead be
 * writing to the PRODUCTION service — exactly the cross-contamination the
 * probe's service-isolation invariant exists to prevent. The port's own
 * default is covered by the store's own suite; the override is not covered
 * anywhere.
 *
 * The runner is injected, so this suite never invokes `/usr/bin/security`,
 * never reaches a credential store, and never performs a native operation: it
 * only records the argument vector the port would have run.
 */
import { describe, expect, test } from 'bun:test'

import {
  isDisposableProbeService,
  NATIVE_AUTH_PROBE_SERVICE_PREFIX,
} from '../shell/scripts/packaged-native-auth-probe'
import { createSystemKeychainPort, DESKTOP_AUTH_SERVICE } from '../shell/src/desktop-auth-store'
import { KeychainAccessError } from '../shell/src/dev-runtime/vault'

/**
 * A disposable probe service, in the shape the prepared probe requires: the
 * exported dotted prefix followed by a token. The prefix is taken from the
 * probe itself, so this service can never drift out of the shape that
 * `isDisposableProbeService` accepts.
 */
const PROBE_SERVICE = `${NATIVE_AUTH_PROBE_SERVICE_PREFIX}0123456789abcdef`

/** Records every argument vector the port would have run. */
function recordingRunner(options: { failWith?: KeychainAccessError } = {}) {
  const seen: string[][] = []
  const run = (args: string[]) => {
    seen.push(args)
    if (options.failWith) throw options.failWith
    if (args[0] === 'find-generic-password') return Buffer.from('stored-value\n', 'utf8')
    return Buffer.alloc(0)
  }
  return { seen, run }
}

/** The value of the `-s` argument in a recorded argument vector. */
function serviceArgument(args: string[]): string | undefined {
  const index = args.indexOf('-s')
  return index === -1 ? undefined : args[index + 1]
}

describe('the system keychain port honours a caller-supplied service', () => {
  test('every operation targets the service the caller supplied', () => {
    const { seen, run } = recordingRunner()
    const port = createSystemKeychainPort({ runSecurity: run, service: PROBE_SERVICE })

    port.get('desktop-user-session')
    port.set('desktop-user-session', 'value')
    port.delete('desktop-user-session')

    expect(seen).toHaveLength(3)
    for (const args of seen) {
      expect(serviceArgument(args)).toBe(PROBE_SERVICE)
      // The account is still the second selector: the override replaces the
      // service, nothing else.
      expect(args[args.indexOf('-a') + 1]).toBe('desktop-user-session')
    }
    // And the production service is never named by any of them.
    for (const args of seen) {
      expect(args).not.toContain(DESKTOP_AUTH_SERVICE)
    }
  })

  test('the canonical service is only the default, never an override', () => {
    const { seen, run } = recordingRunner()
    const port = createSystemKeychainPort({ runSecurity: run })

    port.get('desktop-user-session')

    expect(serviceArgument(seen.at(-1)!)).toBe(DESKTOP_AUTH_SERVICE)
    expect(DESKTOP_AUTH_SERVICE).toBe('com.adea.desktop')
  })

  test('a service override survives a failing operation', () => {
    // A write that fails must not silently fall back to another service.
    const { seen, run } = recordingRunner({
      failWith: new KeychainAccessError('access_denied', 'denied'),
    })
    const port = createSystemKeychainPort({ runSecurity: run, service: PROBE_SERVICE })

    expect(() => port.set('desktop-user-session', 'value')).toThrow(
      'credential store unavailable (access_denied)'
    )
    expect(serviceArgument(seen.at(-1)!)).toBe(PROBE_SERVICE)
    expect(seen.at(-1)).not.toContain(DESKTOP_AUTH_SERVICE)
  })

  test('the override is the service the runner is asked for, not a prefix of it', () => {
    // A runner that derives its own service from the argument vector must see
    // exactly the disposable probe service, never a production one.
    const { seen, run } = recordingRunner()
    const port = createSystemKeychainPort({ runSecurity: run, service: PROBE_SERVICE })

    port.get('desktop-authorization-attempt')

    const service = serviceArgument(seen.at(-1)!)
    expect(service).toBe(PROBE_SERVICE)
    // The service is the exact one, and it is the shape the prepared probe
    // accepts: the exported dotted prefix plus its token.
    expect(service).toBe(`${NATIVE_AUTH_PROBE_SERVICE_PREFIX}0123456789abcdef`)
    expect(service?.startsWith(NATIVE_AUTH_PROBE_SERVICE_PREFIX)).toBe(true)
    // And it is never a production service.
    expect(service?.startsWith('com.adea.desktop')).toBe(false)
  })

  test('the service this suite uses is one the prepared probe accepts', () => {
    // The seam is only probe-compatible if the prepared probe would accept the
    // service the native runner hands it.
    expect(isDisposableProbeService(PROBE_SERVICE)).toBe(true)
    // And the production services the probe refuses stay refused.
    for (const service of ['com.adea.desktop', 'com.adea.desktop.dev-runtime']) {
      expect(isDisposableProbeService(service)).toBe(false)
    }
  })
})
