import { describe, expect, test } from 'bun:test'

import { ROUTER, SPEC_DIRECTORY, brokenLinks, specCoverage } from './check-docs.mjs'

const root = new URL('..', import.meta.url).pathname

// Spec pages only stay current if the path to them stays intact: reachable from
// the router, linked from prose that resolves, and never orphaned by a move.
describe('docs integrity', () => {
  test('every relative link between tracked docs resolves', async () => {
    expect((await brokenLinks(root)).map((link) => `${link.file} -> ${link.target}`)).toEqual([])
  })

  test('the router and the spec directory agree', async () => {
    const { orphaned, missing } = await specCoverage(root)

    // A spec nobody is routed to is a page that rots silently.
    expect(orphaned).toEqual([])
    // A routed spec that no longer exists is a dead instruction.
    expect(missing).toEqual([])
  })

  test('the router names at least the specs it promises', async () => {
    const router = await Bun.file(`${root}${ROUTER}`).text()
    const specs = await Bun.file(`${root}${SPEC_DIRECTORY}/desktop-auth.md`).text()

    expect(router).toContain(SPEC_DIRECTORY)
    // The router's rule is "if you touch X, read spec Y first", so each row
    // pairs a spec with the code it covers.
    expect(router).toMatch(/read spec/i)
    // Each spec states the same-commit expectation, which is what keeps the
    // page and the code in step.
    expect(specs).toContain('same commit')
  })

  test('every spec states what it covers and what pins it', async () => {
    for (const spec of ['desktop-auth', 'local-content', 'updater']) {
      const source = await Bun.file(`${root}${SPEC_DIRECTORY}/${spec}.md`).text()
      expect(source).toStartWith(`# Spec:`)
      expect(source).toContain('Changelog discipline')
      expect(source).toContain('## Pinned by')
    }
  })
})
