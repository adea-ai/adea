import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  BASELINED_ORIGINS,
  CLOUD_BUILD_SOURCE,
  CLOUD_ORIGIN_SOURCE,
  canonicalCloudOrigins,
  scanDesktopOrigins,
  scanSource,
} from './check-desktop-origins.mjs'

const root = new URL('..', import.meta.url).pathname

// The desktop shell talks only to the exact cloud origin baked in at build
// time. These assertions keep that a single fact: one constant in native code,
// one in the build wrapper, agreement between them, and no third literal
// anywhere in the shell. The scanner itself is exercised below so the gate
// cannot pass by failing to look.
describe('desktop cloud-origin pin', () => {
  test('keeps one canonical origin in native code and in the build wrapper', async () => {
    const { rust, build } = await canonicalCloudOrigins(root)

    expect(rust).toBe('https://adea.dev')
    expect(build).toBe(rust)
  })

  test('derives the packaged CSP, the native allowlist, and the client brokering from it', async () => {
    const canonical = (await canonicalCloudOrigins(root)).rust!
    const config = JSON.parse(
      await readFile(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')
    ) as { app: { security: { csp: string } } }
    const auth = await readFile(join(root, 'apps/desktop/src-tauri/src/auth.rs'), 'utf8')
    const cloud = await readFile(join(root, CLOUD_ORIGIN_SOURCE), 'utf8')
    const client = await readFile(join(root, 'apps/desktop/src/main.tsx'), 'utf8')
    const viteConfig = await readFile(join(root, 'apps/desktop/vite.config.ts'), 'utf8')

    // Packaged CSP: the static config names the origin, and the build wrapper
    // regenerates the same directive from the validated value.
    expect(config.app.security.csp).toContain(
      `connect-src 'self' blob: ipc: http://ipc.localhost ${canonical} `
    )
    expect(await readFile(join(root, CLOUD_BUILD_SOURCE), 'utf8')).toContain('${cloudOrigin}')
    // Native allowlist: auth compares the authorization URL against this value
    // and no longer carries an origin literal of its own.
    expect(auth).toContain('use crate::cloud::cloud_origin;')
    expect(auth).toContain('Url::parse(cloud_origin())')
    expect(cloud).toContain('pub fn cloud_origin()')
    expect(cloud).toContain('pub const DEFAULT_CLOUD_ORIGIN: &str = "https://adea.dev"')
    // Packaged client: the origin is injected, never restated.
    expect(viteConfig).toContain('__ADEA_CLOUD_ORIGIN__')
    expect(client).toContain('const cloudOrigin = __ADEA_CLOUD_ORIGIN__')
    expect(client).not.toContain('https://')
  })

  test('allows no origin literal outside the allowlist', async () => {
    const canonical = (await canonicalCloudOrigins(root)).rust!
    const allowed = [
      { origin: canonical, reason: 'the canonical cloud origin' },
      ...BASELINED_ORIGINS,
    ]
    const violations = await scanDesktopOrigins(root, allowed)

    expect(
      violations.map((violation) => `${violation.file}:${violation.line} ${violation.literal}`)
    ).toEqual([])
  })

  test('flags a stray origin so the gate cannot pass by not looking', () => {
    const allowed = [
      { origin: 'https://adea.dev', reason: 'canonical' },
      { origin: 'https://github.com', reason: 'update channel' },
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
    // The canonical origin, the allowlist, infrastructure origins, comments,
    // and `$schema` metadata are not violations.
    expect(
      scanSource(
        [
          `fetch('https://adea.dev/api')`,
          `fetch('https://github.com/adea-ai/adea/releases')`,
          `const dev = 'http://127.0.0.1:1420'`,
          `const ipc = 'http://ipc.localhost'`,
          `"$schema": "https://schema.tauri.app/config/2",`,
          `// mirrors https://evil.example for the test`,
        ].join('\n'),
        'apps/desktop/src/y.ts',
        allowed
      ).map((violation) => violation.line)
    ).toEqual([])
    // Rust test modules name hostile origins on purpose; shipped Rust code
    // does not get that allowance.
    expect(
      scanSource(`let x = 'https://evil.example';`, 'apps/desktop/src-tauri/src/z.rs', allowed)
        .length
    ).toBe(1)
    expect(
      scanSource(
        [`let shipped = 'https://evil.example';`, `#[cfg(test)]`, `mod tests {}`].join('\n'),
        'apps/desktop/src-tauri/src/w.rs',
        allowed
      ).length
    ).toBe(1)
    expect(
      scanSource(
        [`#[cfg(test)]`, `mod tests { const HOSTILE: &str = "https://evil.example"; }`].join('\n'),
        'apps/desktop/src-tauri/src/v.rs',
        allowed
      ).length
    ).toBe(0)
  })
})
