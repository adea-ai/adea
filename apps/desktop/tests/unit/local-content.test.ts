import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const root = new URL('../../../../', import.meta.url)

describe('desktop local content boundary', () => {
  test('exposes only narrow content operations without a database path or key API', async () => {
    const source = await readFile(new URL('../../src/local-content.ts', import.meta.url), 'utf8')
    expect(source).toContain('invoke<LocalContentRef>(')
    expect(source).toContain('local_content_create')
    expect(source).toContain('local_content_read')
    expect(source).toContain('local_content_search')
    expect(source).toContain('local_content_rotate_key')
    expect(source).not.toMatch(/sqlite|databasePath|masterKey|ciphertext|nonce/i)
  })

  test('registers the command family only for the bundled main window capability', async () => {
    const capability = JSON.parse(
      await readFile(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8')
    ) as { permissions: string[]; windows: string[] }
    const permission = await readFile(
      new URL('../../src-tauri/permissions/local-content.toml', import.meta.url),
      'utf8'
    )
    expect(capability.windows).toEqual(['main'])
    expect(capability.permissions).toContain('allow-local-content')
    expect(permission).toContain('local_content_authorize_workspace')
    expect(permission).toContain('local_content_read')
    expect(permission).toContain('local_content_search')
    expect(permission).not.toContain('filesystem')
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
