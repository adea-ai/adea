import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CLOUD_ORIGIN_SOURCE,
  allowedOriginsFor,
  canonicalCloudOrigin,
  isLoopbackOrigin,
  scanDesktopOrigins,
  scanSource,
} from './check-desktop-origins.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

// The desktop client talks only to the exact cloud origin baked in at build
// time. These assertions keep that a single fact: one literal in
// `apps/desktop/scripts/cloud-config.mjs`, validated by the desktop client
// build script and injected into the web app's desktop build as
// `__ADEA_DESKTOP_CLOUD_ORIGIN__`, with no restatement anywhere else. The
// scanner itself is exercised below so the gate cannot pass by failing to look.
const record = (mode: string, cloudOrigin: string) => JSON.stringify({ mode, cloudOrigin })

describe('desktop cloud-origin pin', () => {
  test('keeps one JavaScript literal for the cloud origin', async () => {
    expect(await canonicalCloudOrigin(root)).toBe('https://adea.dev')

    const configSource = await readFile(join(root, CLOUD_ORIGIN_SOURCE), 'utf8')
    expect(configSource).toContain("const DEFAULT_CLOUD_ORIGIN = 'https://adea.dev'")

    // The desktop client build validates that same module and hands the value
    // to the web app's desktop build; the web config never restates it.
    const clientBuild = await readFile(join(root, 'apps/desktop/scripts/client.mjs'), 'utf8')
    expect(clientBuild).toContain("from './cloud-config.mjs'")
    expect(clientBuild).toContain('ADEA_DESKTOP_CLOUD_ORIGIN')
    expect(clientBuild).not.toMatch(/https:\/\/[a-z0-9.-]+/i)

    const viteConfig = await readFile(join(root, 'apps/web/vite.desktop.config.ts'), 'utf8')
    expect(viteConfig).toContain('process.env.ADEA_DESKTOP_CLOUD_ORIGIN')
    expect(viteConfig).toContain('__ADEA_DESKTOP_CLOUD_ORIGIN__')
    expect(viteConfig).not.toMatch(/https:\/\/[a-z0-9.-]+/i)
  })

  test('injects the origin into the single-UI client instead of restating it', async () => {
    const runtime = await readFile(join(root, 'apps/web/src/lib/desktop-runtime.ts'), 'utf8')

    expect(runtime).toContain('declare const __ADEA_DESKTOP_CLOUD_ORIGIN__: string')
    expect(runtime).toContain('desktopCloudOrigin')
    expect(runtime).not.toMatch(/https:\/\/[a-z0-9.-]+/i)
    // The desktop source carries no previous-shell module paths.
    expect(runtime).not.toContain('src-tauri')
    expect(runtime).not.toContain('@tauri-apps')
  })

  test('serves the shell window from loopback only', async () => {
    const entry = await readFile(join(root, 'apps/desktop/shell/src/bun/index.ts'), 'utf8')
    const windowUrl = /url:\s*`([^`]+)`/.exec(entry)?.[1] ?? ''

    expect(windowUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\$\{PORT\}\//)
    expect(entry).toContain("hostname: '127.0.0.1'")
    // A remote application URL is exactly what the loopback pin forbids.
    expect(entry).not.toContain('WebviewUrl::External')
    expect(entry).not.toContain('ADEA_WEB_URL')
    expect(isLoopbackOrigin(windowUrl.replace('${PORT}', '4789'))).toBe(true)
    expect(isLoopbackOrigin('https://adea.dev')).toBe(false)
    expect(isLoopbackOrigin('http://192.168.1.10:4789')).toBe(false)
  })

  test('one persisted build target drives the client and the shell', async () => {
    // Development builds target the local dev server; the hosted origin needs
    // the release build marker, or a named origin plus ADEA_ALLOW_HOSTED_CLOUD.
    const clientBuild = await readFile(join(root, 'apps/desktop/scripts/client.mjs'), 'utf8')
    expect(clientBuild).toContain("release: process.env.ADEA_DESKTOP_RELEASE_BUILD === 'true'")
    expect(clientBuild).toContain('allowHosted: process.env.ADEA_ALLOW_HOSTED_CLOUD')
    expect(clientBuild).toContain('ADEA_DESKTOP_CLOUD_ORIGIN: target.cloudOrigin')
    expect(clientBuild).toContain('serializeDesktopTarget(target)')
    expect(clientBuild).not.toContain('DEFAULT_CLOUD_ORIGIN')

    // The shell reads the record the client build wrote and never infers its
    // target from how it was launched (packaged or not is not release intent).
    const entry = await readFile(join(root, 'apps/desktop/shell/src/bun/index.ts'), 'utf8')
    expect(entry).toContain('resolveCloudOrigin(CLIENT_ROOT)')
    expect(entry).not.toMatch(/resolveCloudOrigin\([^)]*packaged/)
    const proxy = await readFile(join(root, 'apps/desktop/shell/src/cloud-proxy.ts'), 'utf8')
    expect(proxy).toContain('DESKTOP_TARGET_FILE')
    expect(proxy).not.toContain('DEFAULT_CLOUD_ORIGIN')
    expect(proxy).not.toMatch(/packaged/)

    // The release workflow is the one place that marks a build as a release
    // build, on the step that builds the bundled client; nothing sets the
    // hosted opt-in in automation.
    const workflows = join(root, '.github/workflows')
    for (const name of await readdir(workflows)) {
      if (!/\.ya?ml$/.test(name)) continue
      const workflow = await readFile(join(workflows, name), 'utf8')
      expect(workflow).not.toContain('ADEA_ALLOW_HOSTED_CLOUD')
      if (name !== 'release-assets.yml')
        expect(workflow).not.toContain('ADEA_DESKTOP_RELEASE_BUILD')
    }
    const release = await readFile(join(workflows, 'release-assets.yml'), 'utf8')
    const step = release.slice(release.indexOf('- name: Build bundled client'))
    expect(step.slice(0, step.indexOf('\n      - name:', 10))).toContain(
      "ADEA_DESKTOP_RELEASE_BUILD: 'true'"
    )
    // ...and the packaged bundle is checked for it before anything publishes.
    expect(release).toContain('adea-desktop-target.json')
    expect(release).toContain('verify-release-target.mjs')
  })

  test('the release gate accepts only a release build for the hosted origin', async () => {
    const { assertReleaseTarget } =
      await import('../apps/desktop/scripts/verify-release-target.mjs')
    expect(assertReleaseTarget(record('release', 'https://adea.dev'))).toEqual({
      mode: 'release',
      cloudOrigin: 'https://adea.dev',
    })
    for (const text of [
      record('local', 'http://localhost:3000'),
      record('hosted-dev', 'https://adea.dev'),
      record('release', 'http://127.0.0.1:3210'),
      '',
      '{}',
    ]) {
      expect(() => assertReleaseTarget(text)).toThrow()
    }
  })

  test('allows the canonical origin only where it is defined', () => {
    const canonical = 'https://adea.dev'

    expect(
      allowedOriginsFor(CLOUD_ORIGIN_SOURCE, canonical).map((entry) => entry.origin)
    ).toContain(canonical)
    expect(
      allowedOriginsFor('apps/desktop/shell/src/bun/index.ts', canonical).map(
        (entry) => entry.origin
      )
    ).not.toContain(canonical)
    expect(
      allowedOriginsFor('apps/web/src/lib/desktop-runtime.ts', canonical).map(
        (entry) => entry.origin
      )
    ).not.toContain(canonical)
  })

  test('allows no origin literal outside the allowlist', async () => {
    const violations = await scanDesktopOrigins(root, await canonicalCloudOrigin(root))

    expect(
      violations.map((violation) => `${violation.file}:${violation.line} ${violation.literal}`)
    ).toEqual([])
  })

  test('flags a stray origin so the gate cannot pass by not looking', () => {
    const allowed = [
      { origin: 'https://adea.dev', reason: 'canonical' },
      { origin: 'https://github.com', reason: 'release channel' },
    ]

    expect(
      scanSource(`const base = 'https://evil.example/api'\n`, 'apps/web/src/lib/x.ts', allowed)
    ).toEqual([
      {
        file: 'apps/web/src/lib/x.ts',
        line: 1,
        origin: 'https://evil.example',
        literal: 'https://evil.example',
      },
    ])
    // The canonical origin, the allowlist, loopback, comments, and `$schema`
    // metadata are not violations.
    expect(
      scanSource(
        [
          `fetch('https://adea.dev/api')`,
          `fetch('https://github.com/adea-ai/adea/releases')`,
          `const shell = 'http://127.0.0.1:4789'`,
          `"$schema": "https://schema.example/config",`,
          `// mirrors https://evil.example for the test`,
        ].join('\n'),
        'apps/web/src/lib/y.ts',
        allowed
      ).map((violation) => violation.line)
    ).toEqual([])
  })
})
