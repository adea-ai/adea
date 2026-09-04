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
    expect(sceneHost).not.toContain('from "@agent-hq/landscape/runtime"')
    expect(sceneHost).toContain('import("@agent-hq/landscape/runtime")')

    const landscapeRuntime = read('packages/landscape/src/runtime.ts')
    expect(landscapeRuntime).not.toContain('from "./index.js"')
    const hqRoom = read('scenes/hq/src/hq-room-scene.tsx')
    expect(hqRoom).toContain('@agent-hq/landscape/backgrounds')
  })

  test('keeps editor catalogs behind scene-package boundaries', () => {
    const sceneShell = read('packages/scene-shell/src/scene-wrapper.tsx')
    expect(sceneShell).not.toContain('room-designer-scene')
    expect(sceneShell).toContain('import("@agent-hq/characters/customization")')

    const roomScene = read('scenes/room-designer/src/room-designer-scene.tsx')
    expect(roomScene).toContain("from '@agent-hq/interior'")
    expect(roomScene).toContain("from '@agent-hq/hq-scenes'")
    expect(roomScene).toContain('assignedPropsEnabled={false}')
  })

  test('cold-mounts the character designer without the HQ workspace scene', () => {
    const page = read('apps/web/src/app/page.tsx')
    const entry = read('apps/web/src/components/workspace-entry.tsx')
    const desktop = read('apps/desktop/src/desktop-workspace.tsx')
    expect(page).toContain('characterDesigner=')
    expect(page).toContain('roomDesigner=')
    expect(entry).toContain("import('./character-designer-entry')")
    expect(entry).toContain('if (characterDesigner)')
    const navigation = read('apps/web/src/components/workspace-navigation-entry.tsx')
    expect(navigation).toContain('RoomDesignerWorkspace')
    expect(navigation).toContain('roomDesignerEnabled')
    expect(entry).toContain('roomDesigner?: boolean')
    expect(entry).not.toContain("import('./workspace-shell')")
    expect(desktop).toContain("import('./desktop-character-designer')")
    expect(desktop).toContain('if (characterDesigner)')
    expect(desktop).not.toContain('import { HqRoomScene }')
  })

  test('skips physics for the visual-only character studio', () => {
    const sceneHost = read('packages/scene-runtime/src/SceneHost.tsx')
    const characterScene = read('scenes/character-designer/src/character-designer-scene.tsx')
    expect(sceneHost).toContain('physicsEnabled?: boolean')
    expect(sceneHost).toContain('import("@dimforge/rapier3d-compat")')
    expect(characterScene).toContain('physicsEnabled={false}')
    expect(characterScene).toContain('ktx2Enabled={false}')
  })

  test('keeps the lean character runtime smaller than the authoring bundle', () => {
    const runtimeSource = 'packages/characters/src/runtime.ts'
    const runtimePath = 'packages/characters/dist/runtime.js'
    expect(read(runtimeSource)).not.toContain("from 'three/examples/jsm/utils/SkeletonUtils.js'")
    expect(read(runtimeSource)).toContain("import('three/examples/jsm/utils/SkeletonUtils.js')")
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
