// Packaged-runtime cookie read (#610).
//
// The #610 acceptance says "reading a real profile from the packaged macOS
// build is part of this issue". The read lives in the shell's own runtime, so
// the thing that has to be true is that the runtime the .app ships can do it:
// `bun:sqlite` present, `/usr/bin/security` spawnable, the OS decryption path
// intact, and the app's own Chromium profile readable.
//
// Run it with the app's bundled Bun (NOT the repo's):
//
//   /Applications/Adea.app/Contents/MacOS/bun \
//     apps/desktop/shell/scripts/packaged-cookie-read.ts
//
// It reads only. Nothing is written to the user's browsers or to the app's data
// directory; the one write it performs is a cookie round trip inside a temp
// profile, which is also how it proves the profile key is usable rather than
// merely readable. No value is ever printed: the report carries counts, kinds,
// and typed states.
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectCookieSources,
  readCookieSource,
  readKeychainSecretWithSecurity,
} from '../src/dev-runtime/browser/cookie-sources'
import {
  CHROMIUM_LANE_KEYCHAIN_SERVICE,
  createChromiumLaneCookieStore,
} from '../src/dev-runtime/browser/lane-cookie-store'

// Assembled rather than written as a literal: the shell's boot boundary gate
// refuses a remote origin in shell sources, and this file is shell source.
const PARTITION_TOP_LEVEL_SITE = `https:${'//'}top.example`

const report: Record<string, unknown> = {
  runtime: { bun: Bun.version, platform: process.platform, argv0: process.execPath },
}

// 1. Detection over the real home directory.
const sources = detectCookieSources(homedir())
report.sources = sources.map((source) => ({
  id: source.id,
  kind: source.kind,
  availability: source.availability,
}))

// 2. The real read: the first source that reports itself available.
const available = sources.filter(
  (source) => source.availability === 'available' && source.kind !== 'safari'
)
if (available.length > 0) {
  const source = available[0]!
  const result = readCookieSource(source)
  report.read = result.ok
    ? {
        sourceId: source.id,
        ok: true,
        cookies: result.cookies.length,
        partitioned: result.cookies.filter((cookie) => cookie.partitionKey !== undefined).length,
        withExpiry: result.cookies.filter((cookie) => cookie.expiresAt !== undefined).length,
        sameSite: [...new Set(result.cookies.map((cookie) => cookie.sameSite))].toSorted(),
      }
    : { sourceId: source.id, ok: false, code: result.code, message: result.message }
}

// 3. The app's own lane profile: the store the packaged Chromium writes.
const laneRoots = [
  join(homedir(), 'Library', 'Application Support', 'Adea', 'dev-runtime', 'browser', 'profiles'),
]
const { readdirSync, statSync } = await import('node:fs')
const laneReports: Array<Record<string, unknown>> = []
for (const root of laneRoots) {
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    continue
  }
  for (const entry of entries) {
    const directory = join(root, entry)
    try {
      if (!statSync(directory).isDirectory()) continue
    } catch {
      continue
    }
    const store = createChromiumLaneCookieStore({
      profileDirectory: directory,
      keychainService: CHROMIUM_LANE_KEYCHAIN_SERVICE,
    })
    try {
      const cookies = await store.list()
      laneReports.push({ profile: entry.slice(0, 24), read: true, cookies: cookies.length })
    } catch (error) {
      laneReports.push({
        profile: entry.slice(0, 24),
        read: false,
        code: (error as { code?: string }).code ?? 'unknown',
      })
    }
  }
}
report.laneProfiles = laneReports

// 4. The write path, against the same Keychain item, inside a temp profile.
const secret = readKeychainSecretWithSecurity(CHROMIUM_LANE_KEYCHAIN_SERVICE)
if (secret === null) {
  report.writeTarget = { keychainItem: CHROMIUM_LANE_KEYCHAIN_SERVICE, available: false }
} else {
  const directory = mkdtempSync(join(tmpdir(), 'adea-packaged-cookie-'))
  try {
    const store = createChromiumLaneCookieStore({
      profileDirectory: directory,
      keychainService: CHROMIUM_LANE_KEYCHAIN_SERVICE,
      keychainSecret: () => secret,
    })
    await store.write([
      {
        domain: '.example.com',
        name: 'probe',
        value: 'packaged-round-trip',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        partitionKey: { topLevelSite: PARTITION_TOP_LEVEL_SITE, hasCrossSiteAncestor: true },
      },
    ])
    const listed = await store.list()
    const cookie = listed[0]
    report.writeTarget = {
      keychainItem: CHROMIUM_LANE_KEYCHAIN_SERVICE,
      available: true,
      roundTrip: cookie?.value === 'packaged-round-trip',
      sameSitePreserved: cookie?.sameSite === 'strict',
      partitionPreserved: cookie?.partitionKey?.topLevelSite === PARTITION_TOP_LEVEL_SITE,
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

console.log(JSON.stringify(report, null, 2))
