// The publish lists must agree with each other.
//
// `@adea-ai/ui` used to be published from this repository. It no longer is: that
// name belongs to the `adea-ai/ui` design system, which publishes it from its
// own repository, and the npm trusted publisher moved with it. Two publishers on
// one package name is not a slower release, it is a lost one.
//
// The removal had to land in three places — the script's `PUBLISH_PACKAGES`, the
// workflow's `paths` filter, and the workflow's build filter — and it drifted:
// the first two were updated and the third kept building a tarball nothing
// consumed. This test is the guard so a fourth list, or a re-added one, fails
// loudly instead.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

/** Packages this repository must never publish or build for release. */
const MOVED_ELSEWHERE = ['@adea-ai/ui']

function scriptPackages(): string[] {
  const source = read('scripts/publish-packages.mjs')
  const list = /const PUBLISH_PACKAGES = \[(.*?)\]/.exec(source)
  if (!list) throw new Error('PUBLISH_PACKAGES is no longer a literal list')
  return [...list[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
}

function workflowPaths(): string[] {
  return [...read('.github/workflows/publish-packages.yml').matchAll(/'(packages\/[^']+)\/\*\*'/g)]
    .map((match) => match[1]!)
    .toSorted()
}

function workflowBuildFilters(): string[] {
  const source = read('.github/workflows/publish-packages.yml')
  return [...source.matchAll(/turbo run build ([^\n]+)/g)]
    .flatMap((match) => [...match[1]!.matchAll(/--filter=(\S+)/g)].map((filter) => filter[1]!))
    .toSorted()
}

/** `packages/audio` -> `@adea-ai/audio`, so the three lists can be compared. */
function toPackageName(relative: string): string {
  return `@adea-ai/${relative.replace(/^packages\//, '')}`
}

describe('publish package lists agree', () => {
  test('a package moved to its own repository appears in none of the three', () => {
    for (const moved of MOVED_ELSEWHERE) {
      const directory = moved.replace('@adea-ai/', '')
      expect(scriptPackages(), `${moved} is back in PUBLISH_PACKAGES`).not.toContain(
        `packages/${directory}`
      )
      expect(workflowPaths(), `${moved} is back in the paths filter`).not.toContain(
        `packages/${directory}`
      )
      expect(workflowBuildFilters(), `${moved} is back in the build filter`).not.toContain(moved)
    }
  })

  test('the script, the paths filter, and the build filter name the same packages', () => {
    const published = scriptPackages().map(toPackageName).toSorted()
    expect(workflowPaths().map(toPackageName)).toEqual(published)
    expect(workflowBuildFilters()).toEqual(published)
  })
})
