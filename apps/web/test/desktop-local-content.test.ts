import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const root = new URL('../../../', import.meta.url)

describe('desktop local content boundary', () => {
  test('exposes only narrow content operations without a database path or key API', async () => {
    const source = await readFile(
      new URL('../src/lib/desktop-local-content.ts', import.meta.url),
      'utf8'
    )
    expect(source).toContain('invoke<LocalContentRef>(')
    expect(source).toContain('local_content_create')
    expect(source).toContain('local_content_read')
    expect(source).toContain('local_content_search')
    expect(source).toContain('local_content_rotate_key')
    expect(source).not.toMatch(/sqlite|databasePath|masterKey|ciphertext|nonce/i)
  })

  test('registers the command family in the shell command surface', async () => {
    const commands = await readFile(
      new URL('../../desktop/shell/src/commands.ts', import.meta.url),
      'utf8'
    )

    // The shell registry is the only place these commands exist; the client can
    // reach nothing the registry does not name.
    expect(commands).toContain('local_content_authorize_workspace')
    expect(commands).toContain('local_content_read')
    expect(commands).toContain('local_content_search')
    // The surface stays content operations only: no database path or raw key.
    expect(commands).not.toContain('sqlite')
    expect(commands).not.toContain('masterKey')
    expect(commands).not.toContain('databasePath')
  })

  test('keeps private-content implementation out of browser and cloud packages', async () => {
    // The browser workspace root is the Start route that mounts the shell.
    const browserRoute = await readFile(
      new URL('apps/web/src/start/routes/index.tsx', root),
      'utf8'
    )
    const client = await readFile(new URL('packages/api-client/src/index.ts', root), 'utf8')
    expect(browserRoute).not.toContain('local-content')
    expect(client).not.toMatch(/rusqlite|master-key|local-content\.sqlite/i)
  })
})
