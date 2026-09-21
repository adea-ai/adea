import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { readdirSync } from 'node:fs'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
/** Walks a source directory (recursively) and returns every file's text. */
function sourceTree(relativeDir: string): string[] {
  const absolute = resolve(root, relativeDir)
  const files: string[] = []
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${relativeDir}/${entry.name}`
    if (entry.isDirectory()) files.push(...sourceTree(child))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(read(child))
  }
  return files
}

describe('Dev View dependency and bundle boundaries', () => {
  test('loads the Dev package only through the workspace navigation dynamic boundary', () => {
    const navigation = read('apps/web/src/components/workspace-navigation.tsx')
    expect(navigation).toContain("import('@adea-ai/dev-view')")
    expect(read('packages/dev-view/src/dev-workspace-entry.tsx')).toContain(
      "import '@adea-ai/ui/dev-view.css'"
    )
    expect(navigation).not.toMatch(/^import .*@adea-ai\/dev-view/m)

    for (const entry of [
      'apps/web/src/start/workspace-mount.tsx',
      'apps/web/src/components/workspace-entry.tsx',
    ]) {
      expect(read(entry)).not.toContain('@adea-ai/dev-view')
    }
  })

  test('keeps privileged libraries and donor frameworks out of the shared package', () => {
    const manifest = read('packages/dev-view/package.json')
    for (const forbidden of ['electron', 'react', 'zustand', '@pierre/']) {
      expect(manifest).not.toContain(`"${forbidden}`)
    }
    // Issue #396 moved the xterm family into the terminal slice: it must be
    // reachable only through the lazy `./terminal` subpath so Chat/Virtual
    // graphs never pull a renderer chunk.
    expect(manifest).toContain('"@xterm/xterm"')
    const terminalSources = [...sourceTree('packages/dev-view/src/terminal')]
    expect(terminalSources.length).toBeGreaterThan(0)
    for (const source of terminalSources) {
      expect(source).not.toMatch(/^import .*@adea-ai\/dev-view/m)
    }
    expect(read('packages/dev-view/src/index.ts')).not.toContain('./terminal')
    // Issue #399 moves the CodeMirror family into the editor slice under the
    // same rule: manifest-visible (MIT, pinned), statically imported only by
    // the lazy `src/editor` sources, and reachable through the `./editor`
    // subpath — never through the shared package root.
    expect(manifest).toContain('"@codemirror/view"')
    const editorSources = [...sourceTree('packages/dev-view/src/editor')]
    expect(editorSources.length).toBeGreaterThan(0)
    for (const source of editorSources) {
      expect(source).not.toMatch(/^import .*@adea-ai\/dev-view/m)
    }
    expect(read('packages/dev-view/src/index.ts')).not.toContain('./editor')
    const mirrorSource = read('packages/dev-view/src/editor/editor-mirror.ts')
    expect(mirrorSource).toContain('@codemirror/view')
    // Path-aware walk: no file outside `src/editor` may reference the family.
    const codemirrorOffenders: string[] = []
    const walkSources = (relativeDir: string): void => {
      const absolute = resolve(root, relativeDir)
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const child = `${relativeDir}/${entry.name}`
        if (entry.isDirectory()) walkSources(child)
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          if (!child.includes('/src/editor/') && read(child).includes('@codemirror'))
            codemirrorOffenders.push(child)
        }
      }
    }
    walkSources('packages/dev-view/src')
    expect(codemirrorOffenders).toEqual([])
    const source = [
      read('packages/dev-view/src/dev-workspace-entry.tsx'),
      read('packages/dev-view/src/layout/operations.ts'),
      read('packages/dev-view/src/layout/persistence.ts'),
    ].join('\n')
    expect(source).not.toContain('desktopInvoke(')
    expect(source).not.toContain('localStorage')
    const desktopSeam = read('apps/web/src/lib/desktop-dev-runtime.ts')
    expect(desktopSeam).toContain('channel_unauthenticated')
    expect(desktopSeam).not.toContain('desktopInvoke')
    expect(desktopSeam).not.toContain("from './desktop-bridge'")

    // The host seam is the production composition root: it registers every
    // reachable provider, fills the rest with typed-unavailable providers,
    // and publishes the operation/provider matrix as acceptance evidence
    // (remediation gate 2026-09-19; matrix pinned by
    // apps/desktop/tests/dev-runtime-composition.test.ts).
    const hostSeam = read('apps/desktop/shell/src/dev-runtime/index.ts')
    expect(hostSeam).toContain('createDevRuntimeHost')
    expect(hostSeam).toContain('typed_unavailable')
    expect(hostSeam).toContain('no host adapter is available for')
    expect(read('apps/desktop/shell/src/commands.ts')).not.toContain("'dev.runtime.execute.v1'")
  })

  test('pins generated decoders to the normative operation registry', () => {
    const generator = read('scripts/generate-dev-runtime-contract.mjs')
    expect(generator).toContain('docs/specs/dev-runtime-operations.json')
    expect(generator).toContain("'--check'")
    expect(read('packages/types/src/dev-runtime-registry.ts')).toContain(
      'Generated by scripts/generate-dev-runtime-contract.mjs'
    )
  })
})
