import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const catalogRoute = join(root, 'apps/web/src/start/routes/api/marketplace/catalog.ts')

// A fresh client with no cached snapshot — the desktop app on a first run, for
// example — reads the catalog through this route, and nothing else in the
// system can serve it. On 2026-09-25 that read returned Cloudflare error 1102
// ("Worker exceeded resource limits") for roughly one attempt in ten, and the
// desktop App Library reported "Plugin catalog unavailable" instead of the
// catalog: the route parsed the tens-of-megabytes Control Plane body into a
// value and encoded it again, holding both copies at once inside the worker.
//
// The proxy beneath it already streams (`streamThrough`), so the invariant to
// pin is that the route hands the upstream body on untouched.
describe('marketplace catalog read stays streamed', () => {
  test('the catalog route streams instead of parsing the body', async () => {
    const source = await readFile(catalogRoute, 'utf8')
    expect(source).toContain('workspaceStreamResponse(response, resolution, request')
    // Buffering the catalog is the regression this guard exists for.
    expect(source).not.toContain('await response.json()')
    expect(source).not.toContain('await response.text()')
    expect(source).not.toContain('workspaceJsonResponse(await')
  })
})
