import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CLOUD_ORIGIN_SOURCE,
  allowedOriginsFor,
  canonicalCloudOrigin,
  isLoopbackOrigin,
  scanDesktopOrigins,
  scanSource,
} from './check-desktop-origins.mjs'

const root = new URL('..', import.meta.url).pathname

// The desktop shell talks only to the exact cloud origin baked in at build
// time. These assertions keep that a single fact: one literal in
// `apps/desktop/scripts/cloud-config.mjs`, injected into the packaged client,
// with no restatement anywhere in the shell. The scanner itself is exercised
// below so the gate cannot pass by failing to look.
describe('desktop cloud-origin pin', () => {
  test('keeps one JavaScript literal for the cloud origin', async () => {
    expect(await canonicalCloudOrigin(root)).toBe('https://adea.dev')

    const configSource = await readFile(join(root, CLOUD_ORIGIN_SOURCE), 'utf8')
    expect(configSource).toContain("const DEFAULT_CLOUD_ORIGIN = 'https://adea.dev'")

    // The build wrapper imports the same module instead of restating it.
    const viteConfig = await readFile(join(root, 'apps/desktop/vite.config.ts'), 'utf8')
    expect(viteConfig).toContain("from './scripts/cloud-config.mjs'")
    expect(viteConfig).toContain('__ADEA_CLOUD_ORIGIN__')
    expect(viteConfig).not.toContain('https://')
  })

  test('injects the origin into the packaged client instead of restating it', async () => {
    const client = await readFile(join(root, 'apps/desktop/src/main.tsx'), 'utf8')

    expect(client).toContain('const cloudOrigin = __ADEA_CLOUD_ORIGIN__')
    expect(client).not.toContain('https://')
    // The desktop source tree carries no previous-shell module paths.
    expect(client).not.toContain('src-tauri')
    expect(client).not.toContain('@tauri-apps')
  })

  test('serves the shell window from loopback only', async () => {
    const entry = await readFile(join(root, 'apps/desktop/shell/src/bun/index.ts'), 'utf8')
    const windowUrl = /url:\s*`([^`]+)`/.exec(entry)?.[1] ?? ''

    expect(windowUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\$\{PORT\}\//)
    expect(entry).toContain("hostname: '127.0.0.1'")
    // A remote application URL is exactly what the loopback pin forbids.
    expect(entry).not.toContain('WebviewUrl::External')
    expect(isLoopbackOrigin(windowUrl.replace('${PORT}', '4789'))).toBe(true)
    expect(isLoopbackOrigin('https://adea.dev')).toBe(false)
    expect(isLoopbackOrigin('http://192.168.1.10:4789')).toBe(false)
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
      scanSource(`const base = 'https://evil.example/api'\n`, 'apps/desktop/src/x.ts', allowed)
    ).toEqual([
      {
        file: 'apps/desktop/src/x.ts',
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
        'apps/desktop/src/y.ts',
        allowed
      ).map((violation) => violation.line)
    ).toEqual([])
  })
})
