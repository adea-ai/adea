import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const shell = join(root, 'apps/desktop/src-tauri')
const client = join(root, 'apps/desktop/src')

// The shell defines an app ACL manifest, so Tauri rejects any command that is
// registered but not granted, and any privilege granted for a command that no
// longer exists stays in the ACL forever. `apps/desktop/src-tauri/src/ipc_contract.rs`
// asserts the same contract for `cargo test`; these assertions are the copy the
// required validation lane runs, and they add the direction the Rust test cannot
// see: which commands the packaged client actually calls.
async function registeredCommands(): Promise<Set<string>> {
  const main = await readFile(join(shell, 'src/main.rs'), 'utf8')
  const start = main.indexOf('generate_handler![')
  expect(start).toBeGreaterThan(-1)
  const body = main.slice(start, main.indexOf(']', start))
  return new Set(
    body
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) => line.length > 0 && !line.startsWith('#') && !line.includes('generate_handler')
      )
      .map((line) => line.replace(/,$/, '').split('::').at(-1)!)
  )
}

type Grant = { identifier: string; description: string; commands: string[] }

// Permission files are TOML; the schema is regular enough to read the three
// fields the contract cares about without a parser dependency.
async function permissionGrants(): Promise<Grant[]> {
  const directory = join(shell, 'permissions')
  const files = (await readdir(directory)).filter((file) => file.endsWith('.toml')).sort()
  expect(files.length).toBeGreaterThan(0)

  return Promise.all(
    files.map(async (file) => {
      const raw = await readFile(join(directory, file), 'utf8')
      const identifier = /identifier\s*=\s*"([^"]+)"/.exec(raw)?.[1]
      const description = /description\s*=\s*"([^"]+)"/.exec(raw)?.[1]
      const allow = /commands\.allow\s*=\s*\[([\s\S]*?)\]/.exec(raw)?.[1]
      expect(identifier).toBeDefined()
      expect(description).toBeDefined()
      expect(allow).toBeDefined()
      return {
        identifier: identifier!,
        description: description!,
        commands: [...allow!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!),
      }
    })
  )
}

function difference(left: Set<string>, right: Set<string>) {
  return [...left].filter((value) => !right.has(value)).sort()
}

describe('desktop IPC contract', () => {
  test('grants exactly the commands that are registered', async () => {
    const registered = await registeredCommands()
    const grants = await permissionGrants()
    const granted = new Set(grants.flatMap((grant) => grant.commands))

    // A registered command with no grant is a feature that fails at runtime;
    // a grant with no command is a privilege nobody can use and everybody keeps.
    expect(difference(registered, granted)).toEqual([])
    expect(difference(granted, registered)).toEqual([])
  })

  test('grants every command through exactly one permission', async () => {
    const grants = await permissionGrants()
    const duplicates = grants
      .flatMap((grant) => grant.commands.map((command) => [command, grant.identifier] as const))
      .reduce<Record<string, string[]>>((accumulator, [command, identifier]) => {
        accumulator[command] = [...(accumulator[command] ?? []), identifier]
        return accumulator
      }, {})
    const overGranted = Object.entries(duplicates)
      .filter(([, identifiers]) => identifiers.length > 1)
      .map(([command, identifiers]) => `${command}: ${identifiers.join(', ')}`)

    expect(overGranted).toEqual([])
    for (const grant of grants) {
      expect(grant.commands.length).toBeGreaterThan(0)
      expect(grant.description.length).toBeGreaterThan(0)
    }
  })

  test('wires every app permission into the main-window capability', async () => {
    const grants = await permissionGrants()
    const capability = JSON.parse(
      await readFile(join(shell, 'capabilities/default.json'), 'utf8')
    ) as {
      identifier: string
      windows: string[]
      permissions: string[]
      remote?: unknown
    }
    // App-owned permissions have no plugin namespace; plugin permissions are
    // validated by their own crates.
    const referenced = new Set(
      capability.permissions.filter((permission) => !permission.includes(':'))
    )

    expect(difference(referenced, new Set(grants.map((grant) => grant.identifier)))).toEqual([])
    expect(difference(new Set(grants.map((grant) => grant.identifier)), referenced)).toEqual([])
    expect(capability.windows).toEqual(['main'])
    expect(capability.remote).toBeUndefined()
  })

  test('calls only commands the bundled client is granted', async () => {
    const registered = await registeredCommands()
    const granted = new Set((await permissionGrants()).flatMap((grant) => grant.commands))
    const invoked = new Set<string>()

    for (const file of await readdir(client, { recursive: true })) {
      if (!/\.tsx?$/.test(file)) continue
      const source = await readFile(join(client, file), 'utf8')
      for (const match of source.matchAll(/invoke(?:<[\s\S]*?>)?\(\s*['"]([a-z0-9_]+)['"]/g)) {
        invoked.add(match[1]!)
      }
    }

    expect(invoked.size).toBeGreaterThan(0)
    expect(difference(invoked, registered)).toEqual([])
    expect(difference(invoked, granted)).toEqual([])
  })
})
