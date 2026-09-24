// The real-profile half of #610: a store this machine actually has, read with
// the real Keychain item and the real schema. The fixture suite proves the
// contract; this proves the contract against a browser's own bytes, which is
// the only way to catch a column name or an enum convention that a synthetic
// store agrees with and a real one does not (both were wrong once).
//
// Opt-in by design: it decrypts the user's own session cookies into memory, so
// it runs only under ADEA_REAL_COOKIE_PROFILE=1 and never in CI. Assertions are
// shape-only — no value is ever printed, compared to a literal, or logged.
import { describe, expect, test } from 'bun:test'

import {
  detectCookieSources,
  readCookieSource,
  type DetectedCookieSource,
} from '../shell/src/dev-runtime/browser/cookie-sources'

const optedIn = process.env.ADEA_REAL_COOKIE_PROFILE === '1'

if (optedIn) {
  describe('real installed profile read (#610)', () => {
    test('reads an installed Chromium-family store with the real Keychain item', () => {
      const sources = detectCookieSources(process.env.HOME ?? '')
      const chromiumSources = sources.filter(
        (source): source is DetectedCookieSource =>
          source.kind !== 'firefox' && source.kind !== 'safari'
      )
      const available = chromiumSources.filter((source) => source.availability === 'available')
      if (available.length === 0) {
        console.log('no readable Chromium-family profile on this machine; nothing to verify')
        return
      }

      const source = available[0]!
      const result = readCookieSource(source)
      if (!result.ok && result.code === 'keychain_denied') {
        console.log('the Keychain denied this run; the refusal is typed as required')
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
    })
  })
}
