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
import { shouldPublishVersion } from './publish-version.mjs'

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

function workflowPushPaths(): string[] {
  const pushPaths = /  push:\n    branches: \[main\]\n    paths:\n((?:      - .+\n)+)/.exec(
    read('.github/workflows/publish-packages.yml')
  )
  if (!pushPaths) throw new Error('main push paths filter is missing')
  return [...pushPaths[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
}

function workflowBuildFilters(): string[] {
  const source = read('.github/workflows/publish-packages.yml')
  return [...source.matchAll(/vp run orch:([a-z-]+):build\b/g)]
    .map((match) => `@adea-ai/${match[1]!}`)
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

  test('runs when the version decision helper changes', () => {
    expect(workflowPushPaths()).toContain('scripts/publish-version.mjs')
  })
})

describe('npm trusted publishing configuration', () => {
  const workflow = read('.github/workflows/publish-packages.yml')

  test('grants OIDC only to the publish job while retaining checkout read access', () => {
    const publishJob = /jobs:\n  publish:[\s\S]*?\n    permissions:\n((?:      [^\n]+\n)+)/.exec(
      workflow
    )
    expect(publishJob, 'publish job is missing job-scoped permissions').not.toBeNull()
    expect(publishJob![1]).toMatch(/id-token:\s*write/)
    expect(publishJob![1]).toMatch(/contents:\s*read/)
    expect(workflow).toMatch(/^    if: github\.ref == 'refs\/heads\/main'$/m)
  })

  test('pins a trusted-publishing-capable npm CLI and configures no token fallback', () => {
    expect(workflow).toMatch(/npm install --global npm@12\.2\.0/)
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/)
  })
})

describe('published package version safety', () => {
  test('checks exact registry versions separately from latest and race retries', () => {
    const script = read('scripts/publish-packages.mjs')
    expect(script).toContain('const spec = version ? `${name}@${version}` : name')
    expect(script).toContain("const field = version ? 'version' : 'dist-tags.latest'")
    expect(script).toContain('const exactVersion = await registryVersion(name, version)')
    expect(script).toContain('await registryVersion(name, version)) === version')
  })

  test('skips an exact version even when latest has moved on', () => {
    expect(shouldPublishVersion('0.88.0', '0.88.0', '0.89.0')).toBe(false)
  })

  test('allows a new version that is forward of latest', () => {
    expect(shouldPublishVersion('0.89.1', null, '0.89.0')).toBe(true)
  })

  test('refuses to publish a missing version at or behind latest', () => {
    expect(() => shouldPublishVersion('0.88.1', null, '0.89.0')).toThrow(
      'refusing to publish 0.88.1 because it is below latest 0.89.0'
    )
    expect(() => shouldPublishVersion('0.89.0', null, '0.89.0')).toThrow(
      'refusing to publish 0.89.0 because it matches latest 0.89.0'
    )
  })

  test('fails closed when versions are not stable release versions', () => {
    expect(() => shouldPublishVersion('0.89.1-beta.1', null, '0.89.0')).toThrow(
      'expected a stable three-part version'
    )
  })
})
