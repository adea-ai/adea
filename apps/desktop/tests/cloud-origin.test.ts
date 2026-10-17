import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_CLOUD_ORIGIN,
  DESKTOP_TARGET_FILE,
  LOCAL_DEV_CLOUD_ORIGIN,
  desktopBuildTarget,
  isLoopbackCloudOrigin,
  parseDesktopTarget,
  resolveCloudOrigin,
  resolveShellCloudOrigin,
  serializeDesktopTarget,
} from '../scripts/cloud-config.mjs'
import {
  proxyCloudRequest,
  resolveCloudOrigin as resolveShellCloudOrigin_,
} from '../shell/src/cloud-proxy'
import { createCommandSurface, isAuthorizationUrlOn } from '../shell/src/commands'

// A development run must never reach the hosted cloud by default. Reaching it
// takes two deliberate acts (naming the origin and allowing it), and only a
// release build or the packaged shell keeps the hosted default.
describe('desktop cloud origin selection', () => {
  test('a development run defaults to the local dev server', () => {
    expect(isLoopbackCloudOrigin(LOCAL_DEV_CLOUD_ORIGIN)).toBe(true)
    expect(resolveCloudOrigin({ release: false })).toBe(LOCAL_DEV_CLOUD_ORIGIN)
    expect(resolveCloudOrigin({ explicit: '', release: false })).toBe(LOCAL_DEV_CLOUD_ORIGIN)
  })

  test('a development run accepts a named loopback origin', () => {
    expect(resolveCloudOrigin({ explicit: 'http://127.0.0.1:3210', release: false })).toBe(
      'http://127.0.0.1:3210'
    )
  })

  test('a development run refuses a hosted origin unless it is explicitly allowed', () => {
    for (const allowHosted of [undefined, '', '1', 'yes', 'TRUE', 'false']) {
      expect(() =>
        resolveCloudOrigin({ explicit: DEFAULT_CLOUD_ORIGIN, release: false, allowHosted })
      ).toThrow('ADEA_ALLOW_HOSTED_CLOUD')
    }
    expect(
      resolveCloudOrigin({ explicit: DEFAULT_CLOUD_ORIGIN, release: false, allowHosted: 'true' })
    ).toBe(DEFAULT_CLOUD_ORIGIN)
  })

  test('the opt-in cannot widen what a cloud origin may be', () => {
    for (const explicit of [
      'http://evil.example',
      'https://user:pw@adea.dev',
      'https://adea.dev/api',
      'https://adea.dev/?a=1',
      'ftp://adea.dev',
    ]) {
      expect(() => resolveCloudOrigin({ explicit, release: false, allowHosted: 'true' })).toThrow()
    }
  })

  test('a release build keeps the hosted default and an explicit override', () => {
    expect(resolveCloudOrigin({ release: true })).toBe(DEFAULT_CLOUD_ORIGIN)
    expect(resolveCloudOrigin({ explicit: 'http://127.0.0.1:3210', release: true })).toBe(
      'http://127.0.0.1:3210'
    )
  })
})

describe('persisted desktop build target', () => {
  const noEnv = { release: false }

  test('a build with nothing set is a local build for the loopback dev server', () => {
    expect(desktopBuildTarget(noEnv)).toEqual({
      mode: 'local',
      cloudOrigin: LOCAL_DEV_CLOUD_ORIGIN,
    })
  })

  test('only the release build records the hosted origin', () => {
    expect(desktopBuildTarget({ release: true })).toEqual({
      mode: 'release',
      cloudOrigin: DEFAULT_CLOUD_ORIGIN,
    })
    expect(
      desktopBuildTarget({ explicit: DEFAULT_CLOUD_ORIGIN, release: false, allowHosted: 'true' })
    ).toEqual({ mode: 'hosted-dev', cloudOrigin: DEFAULT_CLOUD_ORIGIN })
    expect(() => desktopBuildTarget({ explicit: DEFAULT_CLOUD_ORIGIN, release: false })).toThrow(
      'ADEA_ALLOW_HOSTED_CLOUD'
    )
  })

  test('the record round-trips and refuses anything inconsistent', () => {
    for (const target of [
      desktopBuildTarget(noEnv),
      desktopBuildTarget({ release: true }),
      desktopBuildTarget({ explicit: DEFAULT_CLOUD_ORIGIN, release: false, allowHosted: 'true' }),
    ]) {
      expect(parseDesktopTarget(serializeDesktopTarget(target))).toEqual(target)
    }
    for (const bad of [
      '',
      'not json',
      '[]',
      '{}',
      '{"mode":"release"}',
      '{"mode":"packaged","cloudOrigin":"https://adea.dev"}',
      '{"mode":"local","cloudOrigin":"https://adea.dev"}',
      '{"mode":"hosted-dev","cloudOrigin":"http://localhost:3000"}',
      '{"mode":"release","cloudOrigin":"https://adea.dev/"}',
      '{"mode":"release","cloudOrigin":"http://evil.example"}',
    ]) {
      expect(() => parseDesktopTarget(bad)).toThrow()
    }
  })

  test('the shell follows the recorded origin and cannot be re-pointed at run time', () => {
    const local = desktopBuildTarget(noEnv)
    const release = desktopBuildTarget({ release: true })
    expect(resolveShellCloudOrigin(local, {})).toBe(LOCAL_DEV_CLOUD_ORIGIN)
    expect(resolveShellCloudOrigin(release, {})).toBe(DEFAULT_CLOUD_ORIGIN)
    // Restating the recorded origin is fine; naming another one is not.
    expect(resolveShellCloudOrigin(local, { explicit: 'http://localhost:3000' })).toBe(
      LOCAL_DEV_CLOUD_ORIGIN
    )
    expect(() => resolveShellCloudOrigin(local, { explicit: DEFAULT_CLOUD_ORIGIN })).toThrow(
      'does not match'
    )
    expect(() => resolveShellCloudOrigin(release, { explicit: 'http://127.0.0.1:3210' })).toThrow(
      'does not match'
    )
  })

  test('a hosted development build also needs the run-time opt-in', () => {
    const hosted = desktopBuildTarget({
      explicit: DEFAULT_CLOUD_ORIGIN,
      release: false,
      allowHosted: 'true',
    })
    for (const allowHosted of [undefined, '', '1', 'false']) {
      expect(() => resolveShellCloudOrigin(hosted, { allowHosted })).toThrow(
        'ADEA_ALLOW_HOSTED_CLOUD'
      )
    }
    expect(resolveShellCloudOrigin(hosted, { allowHosted: 'true' })).toBe(DEFAULT_CLOUD_ORIGIN)
  })
})

// A local `shell:build` bundles the client and the shell into a packaged app.
// The packaged shell must follow the client it carries, not assume the hosted
// default for being packaged.
describe('a no-env local package', () => {
  function clientDirectory(env: { release: boolean }, body: (root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'adea-client-target-'))
    try {
      // Exactly what scripts/client.mjs writes after the web build.
      writeFileSync(
        join(root, DESKTOP_TARGET_FILE),
        serializeDesktopTarget(desktopBuildTarget(env))
      )
      body(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test('serves a loopback origin whatever the shell is launched with', () => {
    clientDirectory({ release: false }, (root) => {
      expect(resolveShellCloudOrigin_(root, {})).toBe(LOCAL_DEV_CLOUD_ORIGIN)
    })
  })

  test('never forwards a request to the hosted origin', async () => {
    const original = globalThis.fetch
    const requested: string[] = []
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requested.push(String(input))
        return new Response('{}')
      }) as typeof fetch
      await new Promise<void>((done) =>
        clientDirectory({ release: false }, (root) => {
          const origin = resolveShellCloudOrigin_(root, {})
          void proxyCloudRequest(
            new Request('http://127.0.0.1:4789/api/v1/workspaces/w1'),
            origin,
            'http://127.0.0.1:4789'
          ).then(() => done())
        })
      )
      expect(requested).toEqual([`${LOCAL_DEV_CLOUD_ORIGIN}/api/v1/workspaces/w1`])
      expect(requested.join(' ')).not.toContain('adea.dev')
    } finally {
      globalThis.fetch = original
    }
  })

  test('cannot be re-pointed at the hosted origin by the launch environment', () => {
    clientDirectory({ release: false }, (root) => {
      expect(() =>
        resolveShellCloudOrigin_(root, {
          ADEA_CLOUD_ORIGIN: DEFAULT_CLOUD_ORIGIN,
          ADEA_ALLOW_HOSTED_CLOUD: 'true',
        })
      ).toThrow('does not match')
    })
  })

  test('a client with no recorded target stops the shell instead of guessing', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-client-no-target-'))
    try {
      expect(() => resolveShellCloudOrigin_(root, {})).toThrow('no build target')
      writeFileSync(join(root, DESKTOP_TARGET_FILE), '{"mode":"nonsense"}')
      expect(() => resolveShellCloudOrigin_(root, {})).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a release build keeps the hosted origin', () => {
    clientDirectory({ release: true }, (root) => {
      expect(resolveShellCloudOrigin_(root, {})).toBe(DEFAULT_CLOUD_ORIGIN)
    })
  })
})

describe('desktop sign-in origin', () => {
  function withSurface(
    cloudOrigin: string | undefined,
    body: (invoke: ReturnType<typeof createCommandSurface>) => void
  ) {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-cloud-origin-'))
    try {
      body(createCommandSurface(dataDir, { cloudOrigin }))
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
  const authorize = (origin: string) => `${origin}/api/auth/desktop/authorize?state=s`

  test('refuses authorize URLs on any origin but the one this run targets', () => {
    withSurface('http://127.0.0.1:3210', (invoke) => {
      for (const url of [authorize(DEFAULT_CLOUD_ORIGIN), authorize('http://127.0.0.1:3211')]) {
        expect(invoke('desktop_auth_start', { authorizationUrl: url })).toEqual({
          ok: false,
          error: 'untrusted authorization url',
        })
      }
    })
  })

  test('refuses every URL when the run has no resolved cloud origin', () => {
    withSurface(undefined, (invoke) => {
      expect(
        invoke('desktop_auth_start', { authorizationUrl: authorize(DEFAULT_CLOUD_ORIGIN) })
      ).toEqual({ ok: false, error: 'untrusted authorization url' })
    })
  })

  test('accepts a credential-free authorize URL on the targeted origin only', () => {
    // Checked on the predicate: invoking the command past this point would open
    // the system browser.
    const origin = 'http://127.0.0.1:3210'
    expect(isAuthorizationUrlOn(authorize(origin), origin)).toBe(true)
    expect(isAuthorizationUrlOn(authorize(DEFAULT_CLOUD_ORIGIN), origin)).toBe(false)
    expect(
      isAuthorizationUrlOn(`http://u:p@127.0.0.1:3210/api/auth/desktop/authorize`, origin)
    ).toBe(false)
    expect(isAuthorizationUrlOn(`${origin}/api/auth/desktop/authorize#x`, origin)).toBe(false)
  })
})
