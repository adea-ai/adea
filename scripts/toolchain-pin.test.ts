import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The toolchain this repository runs on is named in four places: the package manifest, the mise tools, the
// workflows that install it, and the repository instructions that tell an agent which runtime to use. They
// drifted apart before: the manifest and every workflow pinned Bun 1.4.3 while the instructions still said
// 1.4.0, and the Actions cache key named a Vite+ version that nothing kept in step with the dependency.
//
// These checks read the committed configuration only. They do not install, resolve or execute anything, and
// they fail on a difference rather than on a version being newer or older.

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

const manifest = JSON.parse(read('package.json')) as {
  packageManager?: string
  engines?: { node?: string }
  devDependencies?: Record<string, string>
  workspaces?: string[]
}

const bunPin = manifest.packageManager?.replace(/^bun@/, '') ?? ''
const nodePin = manifest.engines?.node ?? ''
const vitePlusPin = manifest.devDependencies?.['vite-plus'] ?? ''

/** The mise tool table, as the two pins it declares. */
function miseTools(): Record<string, string> {
  const tools: Record<string, string> = {}
  for (const line of read('.mise.toml').split('\n')) {
    const match = /^\s*([a-z]+)\s*=\s*"([^"]+)"/.exec(line)
    if (match) tools[match[1]] = match[2]
  }
  return tools
}

/** Every version a workflow installs, with the file it came from. */
function workflowPins(): { file: string; name: string; version: string }[] {
  const pins: { file: string; name: string; version: string }[] = []
  const directory = join(root, '.github', 'workflows')
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.yml'))) {
    const text = readFileSync(join(directory, file), 'utf8')
    for (const match of text.matchAll(
      /^\s*(bun|node)-version:\s*['"]?([0-9][^'"\s]*)['"]?\s*$/gm
    )) {
      pins.push({ file, name: match[1], version: match[2] })
    }
  }
  return pins
}

/** The workspace manifests, by their directory. */
function workspaceManifests(): { name: string; path: string }[] {
  const found: { name: string; path: string }[] = []
  for (const pattern of manifest.workspaces ?? []) {
    const [directory, depth] = pattern.split('/')
    const entries = readdirSync(join(root, directory)).filter((name) =>
      depth ? true : readdirSync(join(root, directory, name)).includes('package.json')
    )
    for (const entry of entries) {
      const path = join(directory, entry, 'package.json')
      try {
        const parsed = JSON.parse(readFileSync(join(root, path), 'utf8')) as { name?: string }
        if (parsed.name) found.push({ name: parsed.name, path })
      } catch {
        // a workspace directory without a manifest is not a package
      }
    }
  }
  return found
}

describe('the pinned toolchain', () => {
  test('the manifest names a Bun and a Node version', () => {
    expect(bunPin).toMatch(/^\d+\.\d+\.\d+$/)
    expect(nodePin).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('the mise tools are the versions the manifest pins', () => {
    const tools = miseTools()
    expect(tools.bun).toBe(bunPin)
    expect(tools.node).toBe(nodePin)
  })

  test('every workflow installs the pinned Bun version', () => {
    const pins = workflowPins().filter((pin) => pin.name === 'bun')
    expect(pins.length).toBeGreaterThan(0)
    for (const pin of pins) {
      expect({ file: pin.file, version: pin.version }).toEqual({
        file: pin.file,
        version: bunPin,
      })
    }
  })

  test('every workflow installs the pinned Node version, or a range of the same major', () => {
    const pins = workflowPins().filter((pin) => pin.name === 'node')
    expect(pins.length).toBeGreaterThan(0)
    for (const pin of pins) {
      const pinned = pin.version === nodePin
      const range = /^\d+$/.test(pin.version) && pin.version === nodePin.split('.')[0]
      expect({ file: pin.file, pinned: pinned || range }).toEqual({ file: pin.file, pinned: true })
    }
  })

  test('the repository instructions name the pinned Bun version', () => {
    const named = [...read('AGENTS.md').matchAll(/\bBun\s+(\d+\.\d+\.\d+)/g)].map(
      (match) => match[1]
    )
    expect(named.length).toBeGreaterThan(0)
    for (const version of named) expect(version).toBe(bunPin)
  })
})

describe('the native checker and the declaration emit', () => {
  const packages = workspaceManifests()

  test('every workspace package that type checks does it with the native checker', () => {
    const checking = packages.filter(
      ({ path }) =>
        (JSON.parse(read(path)) as { scripts?: Record<string, string> }).scripts?.typecheck
    )
    expect(checking.length).toBeGreaterThan(0)
    for (const { name, path } of checking) {
      const scripts = (JSON.parse(read(path)) as { scripts: Record<string, string> }).scripts
      expect({ name, native: scripts.typecheck.includes('bun check') }).toEqual({
        name,
        native: true,
      })
      // `tsconfig.json` is not a call to the TypeScript compiler.
      expect(/\btsc\b/.test(scripts.typecheck)).toBe(false)
    }
  })

  test('every library that builds keeps its declaration emit on tsc', () => {
    const libraries = packages.filter(
      ({ path }) =>
        path.startsWith('packages/') &&
        (JSON.parse(read(path)) as { scripts?: Record<string, string> }).scripts?.build
    )
    expect(libraries.length).toBeGreaterThan(0)
    for (const { name, path } of libraries) {
      const scripts = (JSON.parse(read(path)) as { scripts: Record<string, string> }).scripts
      expect({ name, emits: /\btsc\b/.test(scripts.build) }).toEqual({ name, emits: true })
    }
  })
})

/** The task-cache key the Actions qualification lane publishes. */
const keyTemplate = (): string => {
  const text = read('.github/workflows/task-cache-qualification.yml')
  const match = /key:\s*(production-tasks-[^\n]*)/.exec(text)
  return match?.[1] ?? ''
}

describe('the Actions task-cache key', () => {
  test('the key names the pinned Bun, Node and Vite+ versions', () => {
    const key = keyTemplate()
    expect(key).not.toBe('')
    expect(key).toContain(`-node${nodePin}-`)
    expect(key).toContain(`-bun${bunPin}-`)
    expect(key).toContain(`-vp${vitePlusPin}-`)
  })

  test('the key names the runner platform and architecture, so one platform never restores another', () => {
    const key = keyTemplate()
    expect(key).toContain('${{ runner.os }}')
    expect(key).toContain('${{ runner.arch }}')
  })

  test('the restore prefix is the key without the run that wrote it', () => {
    const text = read('.github/workflows/task-cache-qualification.yml')
    const key = keyTemplate()
    const prefix = key.replace(/-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/, '')
    expect(text).toContain(prefix)
  })
})
