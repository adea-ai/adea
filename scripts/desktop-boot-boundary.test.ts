import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const shellRoot = join(root, 'apps/desktop/shell')
const entry = join(shellRoot, 'src/bun/index.ts')

const SHELL_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js']
// Electrobun's build output (and the client copy inside it) is not shell
// source; scanning it would read the whole bundled client.
const SKIP = new Set([
  'node_modules',
  'dist',
  'dist-desktop',
  '.hutch',
  'build',
  'artifacts',
  '.turbo',
])

async function shellSources(): Promise<Array<{ path: string; source: string }>> {
  const files: string[] = []
  async function walk(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (!SKIP.has(item.name)) await walk(join(directory, item.name))
        continue
      }
      if (SHELL_EXTENSIONS.some((extension) => item.name.endsWith(extension))) {
        files.push(join(directory, item.name))
      }
    }
  }
  await walk(shellRoot)
  return Promise.all(
    files.map(async (path) => ({
      path: path.slice(root.length),
      source: await readFile(path, 'utf8'),
    }))
  )
}

// The previous shell's boot pipeline owned window creation, failure taxonomy,
// and the launch log. The Electrobun shell's boot is the serving main process:
// it binds loopback, serves the built client from disk, injects the bridge, and
// opens the window at that loopback origin. These assertions pin the parts the
// shell cannot get wrong without handing the client a remote page or a wider
// file surface than the bundle.
describe('desktop shell boot', () => {
  test('pins the window and the server to loopback', async () => {
    const source = await readFile(entry, 'utf8')
    const windowUrl = /url:\s*`([^`]+)`/.exec(source)?.[1] ?? ''

    expect(source).toContain("hostname: '127.0.0.1'")
    expect(source).toContain('url: `http://127.0.0.1:${PORT}/`')
    expect(windowUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\$\{PORT\}\//)
    expect(source).toContain('new BrowserWindow(')
    // No remote page may be selected for the window.
    expect(source).not.toContain('WebviewUrl::External')
    expect(source).not.toContain('ADEA_WEB_URL')
  })

  test('serves every remote URL in the shell from loopback', async () => {
    const violations: string[] = []
    for (const { path, source } of await shellSources()) {
      for (const [index, line] of source.split('\n').entries()) {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
        for (const literal of line.match(/https?:\/\/[^\s'"`)]+/g) ?? []) {
          const host = /^https?:\/\/([^/:]+)/.exec(literal)?.[1] ?? ''
          if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') continue
          violations.push(`${path}:${index + 1} ${literal}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('exposes the desktop command endpoint and the bridge', async () => {
    const source = await readFile(entry, 'utf8')

    expect(source).toContain('createCommandSurface')
    expect(source).toContain("'/__adea/invoke'")
    expect(source).toContain('Response.json(invoke(')
    expect(source).toContain("'/__adea/bridge.js'")
    expect(source).toContain('window.__adeaDesktop')
    expect(source).toContain('injectBridge')
    // The bridge sends the same command names through the same-shaped API the
    // client's platform adapter expects.
    expect(source).toContain('fetch("/__adea/invoke"')
    // The bridge is injected into the served document only; no CORS header lets
    // a remote page read command results.
    expect(source).toContain("html.replace('<head>'")
    expect(source).not.toContain('access-control-allow-origin')
  })

  test('serves the web app single-UI build without a desktop client build', async () => {
    const source = await readFile(entry, 'utf8')

    // The shell serves the web app's TanStack Start SPA output; there is no
    // second desktop client pipeline. The packaged app resolves the copy
    // Electrobun stages next to the bundled main process.
    expect(source).toContain("join(import.meta.dir, '../client')")
    expect(source).toContain("'../../../../web/dist-desktop/client'")
    expect(existsSync(join(root, 'apps/desktop/vite.config.ts'))).toBe(false)
    expect(existsSync(join(root, 'apps/desktop/src'))).toBe(false)
    expect(existsSync(join(root, 'apps/desktop/index.html'))).toBe(false)
    const clientBuild = await readFile(join(root, 'apps/desktop/scripts/client.mjs'), 'utf8')
    expect(clientBuild).toContain('@adea-ai/web^...')
    expect(clientBuild).toContain("'desktop:build'")

    // The client ships inside the bundle; a packaged app that only read the
    // repo path would serve nothing.
    const electrobunConfig = await readFile(
      join(root, 'apps/desktop/shell/electrobun.config.ts'),
      'utf8'
    )
    expect(electrobunConfig).toContain("'../../web/dist-desktop/client': 'client'")
  })

  test('confines the served client root to the bundled client directory', async () => {
    const source = await readFile(entry, 'utf8')

    expect(source).toContain('normalize(decodeURIComponent(url.pathname))')
    expect(source).toContain('filePath.startsWith(CLIENT_ROOT)')
    expect(source).toContain('status: 403')
    // The traversal guard has to run before the file is read.
    expect(source.indexOf('startsWith(CLIENT_ROOT)')).toBeLessThan(
      source.indexOf('Bun.file(filePath)')
    )
  })

  test('keeps dynamic code evaluation out of the shell', async () => {
    const violations = (await shellSources()).flatMap(({ path, source }) =>
      ['eval(', 'new Function(']
        .filter((token) => source.includes(token))
        .map((token) => `${path}: ${token}`)
    )

    expect(violations).toEqual([])
  })
})
