// The real-profile half of #610: a store this machine actually has, read with
// the real Keychain item and the real schema. The fixture suite proves the
// contract; this proves the contract against a browser's own bytes, which is
// the only way to catch a column name or an enum convention that a synthetic
// store agrees with and a real one does not (both were wrong once).
//
// Opt-in by design: it decrypts the user's own session cookies into memory, so
// it runs only under ADEA_REAL_COOKIE_PROFILE=1 and never in CI. Assertions are
// shape-only — no value is ever printed, compared to a literal, or logged.
//
// Skipping is reported as skipping. An earlier version returned early when no
// profile was readable or the Keychain denied, which bun recorded as a PASS: the
// lane went green having asserted nothing at all, which is the exact false
// confidence this file exists to prevent. Detection is separated out below so it
// always runs and always asserts something real, and the decrypt half is a real
// skip when the machine cannot support it.
import { describe, expect, test } from 'bun:test'

import {
  detectCookieSources,
  readCookieSource,
  type DetectedCookieSource,
} from '../shell/src/dev-runtime/browser/cookie-sources'

const optedIn = process.env.ADEA_REAL_COOKIE_PROFILE === '1'

function chromiumSources(): DetectedCookieSource[] {
  return detectCookieSources(process.env.HOME ?? '').filter(
    (source): source is DetectedCookieSource =>
      source.kind !== 'firefox' && source.kind !== 'safari'
  )
}

/** The first Chromium-family profile this machine can actually read. */
function readableSource(): DetectedCookieSource | undefined {
  return chromiumSources().find((source) => source.availability === 'available')
}

if (optedIn) {
  describe('real installed profile read (#610)', () => {
    // Always runs, always asserts: whatever the machine has, detection must
    // report a typed row per profile with a real availability value. A browser
    // that cannot be read must be SAYED, not omitted.
    test('detects every installed profile with a typed availability', () => {
      const all = detectCookieSources(process.env.HOME ?? '')
      expect(all.length).toBeGreaterThan(0)
      for (const source of all) {
        expect(['available', 'locked', 'unsupported_format', 'unreadable']).toContain(
          source.availability
        )
        expect(source.id.length).toBeGreaterThan(0)
        expect(source.label.length).toBeGreaterThan(0)
      }
      // A detected-but-unreadable Chromium profile must still be present as a
      // typed row, so a user is never shown an empty list that reads as
      // "this browser has no cookies".
      for (const source of chromiumSources())
        expect(['available', 'locked', 'unreadable'] as string[]).toContain(source.availability)
    })

    // A real skip, not a quiet pass: with no readable profile there is nothing
    // to verify, and the lane must SAY so rather than report green.
    test.skipIf(readableSource() === undefined)(
      'decrypts an installed store with the real Keychain item',
      () => {
        const source = readableSource()!
        const result = readCookieSource(source)
        if (!result.ok && result.code === 'keychain_denied') {
          // A denied Keychain cannot exercise the decrypt path on this machine.
          // Rather than pass having verified nothing, assert the refusal
          // contract that IS checkable — a denial must be typed and actionable,
          // never a silent empty success or a plaintext write — and state
          // plainly that the happy path was not covered.
          expect(result.code).toBe('keychain_denied')
          expect(result.remediation).toBeDefined()
          console.log(
            'DECRYPT PATH NOT EXERCISED: the Keychain denied this run. The typed ' +
              'refusal was verified; the real-store decrypt was not.'
          )
          return
        }
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`)

        expect(result.cookies.length).toBeGreaterThan(0)
        const sameSites = new Set(result.cookies.map((cookie) => cookie.sameSite))
        for (const sameSite of sameSites)
          expect(['no_restriction', 'lax', 'strict', 'unspecified']).toContain(sameSite)
        // Real rows always carry the identity triple; an empty domain or path
        // would mean the column mapping read the wrong column.
        for (const cookie of result.cookies.slice(0, 200)) {
          expect(cookie.domain.length).toBeGreaterThan(0)
          expect(cookie.path.startsWith('/')).toBe(true)
          expect(cookie.name.length).toBeGreaterThan(0)
          // Ciphertext handed back as a value is the failure this catches.
          expect(cookie.value.startsWith('v10')).toBe(false)
          expect(cookie.value.startsWith('v11')).toBe(false)
        }
        // Shape report only: counts and a digest, never a value.
        const partitioned = result.cookies.filter((cookie) => cookie.partitionKey !== undefined)
        const expiring = result.cookies.filter((cookie) => cookie.expiresAt !== undefined)
        console.log(
          [
            `source=${source.id}`,
            `cookies=${result.cookies.length}`,
            `partitioned=${partitioned.length}`,
            `with-expiry=${expiring.length}`,
            `same-site=${[...sameSites].toSorted().join('/')}`,
          ].join(' ')
        )
      }
    )
  })
}
