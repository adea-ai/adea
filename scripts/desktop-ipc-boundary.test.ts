import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const registrySource = join(root, 'apps/desktop/shell/src/commands.ts')
const client = join(root, 'apps/desktop/src')
const packages = join(root, 'packages')

/** Commands the shell registers. The shell's `invoke` rejects anything else. */
async function registeredCommands(): Promise<Set<string>> {
  const source = await readFile(registrySource, 'utf8')
  const start = source.indexOf('const handlers')
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('return function invoke', start))
  const registry = new Set(
    [...body.matchAll(/^\s{4}([a-z][a-z0-9_]*):\s*\(/gm)].map((match) => match[1]!)
  )
  expect(registry.size).toBeGreaterThan(0)
  return registry
}

async function* typescriptSources(directory: string) {
  if (!existsSync(directory)) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      yield* typescriptSources(join(directory, entry.name))
      continue
    }
    if (entry.isFile() && /\.tsx?$/.test(entry.name)) yield join(directory, entry.name)
  }
}

/** Every client-side source the command contract covers. */
async function coveredSources(): Promise<string[]> {
  const roots = [client, ...(await readdir(packages)).map((name) => join(packages, name, 'src'))]
  const files: string[] = []
  for (const directory of roots) {
    for await (const path of typescriptSources(directory)) files.push(path)
  }
  return files.sort()
}

/** Command names the client and the shared packages pass to the bridge. */
async function invokedCommands(): Promise<Set<string>> {
  const invoked = new Set<string>()
  for (const path of await coveredSources()) {
    const source = await readFile(path, 'utf8')
    for (const match of source.matchAll(/invoke(?:<[\s\S]*?>)?\(\s*['"]([a-z0-9_]+)['"]/g)) {
      invoked.add(match[1]!)
    }
  }
  return invoked
}

function difference(left: Set<string>, right: Set<string>) {
  return [...left].filter((value) => !right.has(value)).sort()
}

/**
 * Commands the shell may expose without a client call site. Keep this empty
 * when possible: every entry is a promise the shell makes that nothing uses.
 */
const SHELL_ONLY_COMMANDS = new Set<string>()

// The shell has no ACL manifest: its `invoke` is the whole command surface, so
// a name the client calls but the registry does not know fails at runtime, and
// a registry entry no client calls is dead surface the shell still carries.
// This is the cross-check the previous per-command ACL gave the Rust lane.
describe('desktop IPC contract', () => {
  test('routes every client command through the platform bridge', async () => {
    const bridge = await readFile(join(root, 'apps/desktop/src/platform/bridge.ts'), 'utf8')

    expect(bridge).toContain('window.__adeaDesktop')
    expect(bridge).toContain('shell().invoke(cmd, args)')
    // The client must not reach back to the previous shell's API.
    const traces: string[] = []
    for (const path of await coveredSources()) {
      const source = await readFile(path, 'utf8')
      if (/@tauri-apps|__TAURI/.test(source)) traces.push(path)
    }
    expect(traces).toEqual([])
  })

  test('calls only commands the shell registers', async () => {
    const registered = await registeredCommands()
    const invoked = await invokedCommands()

    expect(invoked.size).toBeGreaterThan(0)
    expect(difference(invoked, registered)).toEqual([])
  })

  test('registers no command without a client call site', async () => {
    const registered = await registeredCommands()
    const invoked = await invokedCommands()

    expect(
      difference(registered, invoked).filter((command) => !SHELL_ONLY_COMMANDS.has(command))
    ).toEqual([])
    for (const command of SHELL_ONLY_COMMANDS) {
      expect(registered.has(command)).toBe(true)
    }
  })

  test('scans the invoke strings the client actually uses', async () => {
    const invoked = await invokedCommands()

    // The parser has to see multi-line generics (`invoke<\n  Readonly<…>\n>('x')`)
    // or the cross-check passes by finding nothing.
    expect(invoked.has('local_content_health')).toBe(true)
    expect(invoked.has('local_content_rotate_key')).toBe(true)
    expect(invoked.has('desktop_auth_take_callback')).toBe(true)
    expect(invoked.has('adea_app_version')).toBe(true)
  })
})
