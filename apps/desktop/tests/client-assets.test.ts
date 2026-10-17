import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveDesktopClient } from '../shell/src/client-assets'

const root = await mkdtemp(join(tmpdir(), 'stale-desktop-client-'))
await mkdir(join(root, 'assets/agent-sim'), { recursive: true })
await writeFile(join(root, 'index.html'), '<main>Chat and Dev</main>')
await writeFile(join(root, 'assets/agent-sim/engine.js'), 'private-stale-engine')
await writeFile(join(root, 'assets/application.js'), 'public-application')
afterAll(() => rm(root, { recursive: true, force: true }))

for (const path of [
  '/assets/agent-sim',
  '/assets/agent-sim/',
  '/assets/agent-sim/engine.js',
  '/assets/%61gent-sim/engine.js',
  '/assets%2fagent-sim%2fengine.js',
  '/assets//agent-sim///engine.js',
  '//assets///agent-sim/engine.js',
  '/assets%5cagent-sim%5cengine.js',
  '/ASSETS/AGENT-SIM/engine.js',
  '/safe/../assets/%61gent-sim/engine.js',
  '/assets/%E0%A4%A/engine.js',
]) {
  test(`refuses stale pack request ${path}`, async () => {
    const response = await serveDesktopClient(new Request(`http://localhost${path}`), root)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('')
    // The deny happens even when the root cannot be read or resolved.
    expect(
      (await serveDesktopClient(new Request(`http://localhost${path}`), '/never-read')).status
    ).toBe(404)
  })
}

test('serves conventional app files and retains per-document bootstrap injection', async () => {
  const request = new Request('http://localhost/workspace')
  const html = await serveDesktopClient(
    request,
    root,
    (body, incoming) => body + new URL(incoming.url).pathname
  )
  expect(await html.text()).toBe('<main>Chat and Dev</main>/workspace')
  const script = await serveDesktopClient(
    new Request('http://localhost/assets/application.js'),
    root
  )
  expect(await script.text()).toBe('public-application')
  expect(script.headers.get('content-type')).toBe('text/javascript')
  expect(
    (await serveDesktopClient(new Request('http://localhost/assets/missing.js'), root)).status
  ).toBe(404)
})

test('refuses links escaping the served client', async () => {
  await symlink('/etc/hosts', join(root, 'assets/escape'))
  expect(
    (await serveDesktopClient(new Request('http://localhost/assets/escape'), root)).status
  ).toBe(403)
})
