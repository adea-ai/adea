import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

function readTypeScriptSources(directory: string): string {
  return readdirSync(resolve(root, directory))
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => read(`${directory}/${name}`))
    .join('\n')
}

describe('scene package boundaries', () => {
  test('keeps normal HQ sources on lean runtime entrypoints', () => {
    const hqSources = readTypeScriptSources('scenes/hq/src')
    expect(hqSources).not.toMatch(
      /from ['"]@agent-hq\/characters['"]|from ['"]@agent-hq\/interior['"]|from ['"]@agent-hq\/(character|room)-designer-scene['"]|import\(['"]@agent-hq\/(character|room)-designer-scene['"]\)/
    )
    expect(hqSources).toContain('@agent-hq/characters/runtime')
    expect(hqSources).toContain('@agent-hq/interior/room-config')

    const sceneHost = read('packages/scene-runtime/src/SceneHost.tsx')
    expect(sceneHost).not.toMatch(
      /from ['"]@agent-hq\/characters['"]|from ['"]@agent-hq\/interior['"]|from ['"]@agent-hq\/interior\/catalog['"]/
    )
    expect(sceneHost).toContain('import("@agent-hq/characters/preview")')
    expect(sceneHost).toContain('import("@agent-hq/interior/runtime")')
  })

  test('keeps editor catalogs behind scene-package boundaries', () => {
    const sceneShell = read('packages/scene-shell/src/scene-wrapper.tsx')
    expect(sceneShell).not.toContain('import("./room-designer")')
    expect(sceneShell).toContain('import("@agent-hq/room-designer-scene")')
    expect(sceneShell).toContain('import("@agent-hq/characters/customization")')

    const roomScene = read('scenes/room-designer/src/room-designer-scene.tsx')
    expect(roomScene).toContain("from '@agent-hq/interior'")
  })

  test('keeps the lean character runtime smaller than the authoring bundle', () => {
    const runtimeSource = 'packages/characters/src/runtime.ts'
    const runtimePath = 'packages/characters/dist/runtime.js'
    const authoringSources = [
      'packages/characters/src/catalog.ts',
      'packages/characters/src/configuration.ts',
      'packages/characters/src/customization.ts',
      'packages/characters/src/generated-part-offsets.ts',
      'packages/characters/src/generated-parts.ts',
    ]
    const authoringPaths = authoringSources.map((path) =>
      path.replace('/src/', '/dist/').replace('.ts', '.js')
    )
    const sizeOf = (outputPath: string, sourcePath: string) =>
      existsSync(resolve(root, outputPath))
        ? statSync(resolve(root, outputPath)).size
        : Buffer.byteLength(read(sourcePath))

    const runtimeBytes = sizeOf(runtimePath, runtimeSource)
    const authoringBytes = authoringPaths.every((path) => existsSync(resolve(root, path)))
      ? authoringPaths.reduce((total, path) => total + statSync(resolve(root, path)).size, 0)
      : authoringSources.reduce((total, path) => total + Buffer.byteLength(read(path)), 0)
    expect(runtimeBytes).toBeLessThan(authoringBytes)
  })
})
