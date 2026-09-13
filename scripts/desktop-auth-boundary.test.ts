import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCommandSurface } from '../apps/desktop/shell/src/commands'

const root = new URL('..', import.meta.url).pathname
const authModule = join(root, 'packages/auth/src/desktop.ts')
const shellCommands = join(root, 'apps/desktop/shell/src/commands.ts')

// The PKCE handoff is implemented once in `packages/auth/src/desktop.ts` and is
// shared by the browser and the shell; these assertions pin the parts of that
// contract the shell has to honour, and the shell-side commands that carry it
// (`desktop_auth_start` opens the system browser, `desktop_auth_take_callback`
// is a single read-and-clear).
describe('desktop authorization PKCE and callback invariants', () => {
  test('binds the callback to the adea scheme with a single-use S256 attempt', async () => {
    const source = await readFile(authModule, 'utf8')

    expect(source).toContain("const DESKTOP_CALLBACK_URI = 'adea://auth/callback'")
    expect(source).toContain("url.searchParams.set('code_challenge_method', 'S256')")
    expect(source).toContain("url.searchParams.set('response_type', 'code')")
    expect(source).toContain("url.searchParams.set('redirect_uri', attempt.redirectUri)")
    // Single use: a consumed attempt cannot be replayed.
    expect(source).toContain(
      "if (attempt.used) throw new Error('Desktop authorization was already consumed')"
    )
    expect(source).toContain('attempt.used = true')
    expect(source).toContain('await vault.clear()')
  })

  test('refuses callbacks that carry credentials, duplicates, or a mismatched state', async () => {
    const source = await readFile(authModule, 'utf8')

    for (const parameter of [
      'access_token',
      'id_token',
      'refresh_token',
      'session',
      'session_token',
    ]) {
      expect(source).toContain(`'${parameter}'`)
    }
    expect(source).toContain('FORBIDDEN_CALLBACK_PARAMETERS.some')
    expect(source).toContain('constantTimeEqual(attempt.state, state)')
    expect(source).toContain('constantTimeEqual(attempt.nonce, nonce)')
    expect(source).toContain('new Set(parameterNames).size !== parameterNames.length')
    expect(source).toContain('Desktop authorization callback is not trusted')
  })

  test('pins the authorization origin to HTTPS or loopback', async () => {
    const source = await readFile(authModule, 'utf8')

    expect(source).toContain("url.protocol !== 'https:'")
    expect(source).toContain("url.protocol === 'http:' && loopback")
    expect(source).toContain("throw new Error('Desktop auth origin must use HTTPS')")
    // The shared module never carries an origin literal of its own; the cloud
    // origin arrives as an argument from the client build.
    expect(source).not.toMatch(/https:\/\/[a-z0-9.-]+/i)
  })
})

describe('desktop shell auth commands', () => {
  test('implements the auth command family with one read-and-clear callback', async () => {
    const source = await readFile(shellCommands, 'utf8')

    expect(source).toContain('desktop_auth_start:')
    expect(source).toContain('desktop_auth_take_callback:')
    expect(source).toContain('desktop_auth_attempt_load')
    expect(source).toContain('desktop_auth_attempt_save')
    expect(source).toContain('desktop_auth_attempt_clear')
    // A missing authorization URL is refused before the browser is opened.
    expect(source).toContain("if (!url) throw new Error('missing authorization url')")
    // The sign-in page opens in the system browser, never in the shell window.
    expect(source).toContain("Bun.spawn(['open', url])")
    // The callback is read once and cleared in the same handler.
    expect(source.match(/clear\('auth-callback\.json'\)/g)).toHaveLength(1)
  })

  test('consumes the stored callback exactly once', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-auth-'))
    try {
      const callback = 'adea://auth/callback?code=code-123&nonce=nonce-123&state=state-123'
      mkdirSync(join(dataDir, 'desktop-state'), { recursive: true })
      writeFileSync(join(dataDir, 'desktop-state', 'auth-callback.json'), JSON.stringify(callback))
      const invoke = createCommandSurface(dataDir)

      expect(invoke('desktop_auth_take_callback')).toEqual({ ok: true, value: callback })
      expect(existsSync(join(dataDir, 'desktop-state', 'auth-callback.json'))).toBe(false)
      // The second read has nothing to hand out.
      expect(invoke('desktop_auth_take_callback')).toEqual({ ok: true, value: null })
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('refuses unknown commands instead of evaluating them', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-auth-'))
    try {
      const invoke = createCommandSurface(dataDir)

      expect(invoke('desktop_auth_surprise')).toEqual({
        error: 'unknown command: desktop_auth_surprise',
        ok: false,
      })
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })
})

describe('desktop packaging and client boundary', () => {
  test('builds the client from the workspace before the shell bundles it', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
    const shellRunner = await readFile(join(root, 'apps/desktop/scripts/shell.mjs'), 'utf8')
    const desktopMain = await readFile(join(root, 'apps/desktop/src/main.tsx'), 'utf8')

    expect(manifest.scripts['client:prepare']).toContain(
      'turbo run build --filter=@adea-ai/desktop^...'
    )
    expect(manifest.scripts['client:prepare']).not.toContain('scenes/hq build')
    expect(shellRunner).toContain("['run', 'client:build']")
    // The client build runs before the shell bundling step.
    expect(shellRunner.indexOf("['run', 'client:build']")).toBeGreaterThan(-1)
    expect(shellRunner.indexOf("['run', 'client:build']")).toBeLessThan(
      shellRunner.indexOf("['--bun', 'electrobun'")
    )
    // The client is always served from the bundle; no remote application URL.
    expect(desktopMain).not.toContain('ADEA_WEB_URL')
    expect(desktopMain).not.toContain('https://')
  })

  test('enters the bundled spatial workspace after guest bootstrap', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
    const client = await readFile(join(root, 'apps/desktop/src/main.tsx'), 'utf8')
    const workspace = await readFile(join(root, 'apps/desktop/src/desktop-workspace.tsx'), 'utf8')

    expect(manifest.dependencies['@adea-ai/hq-scenes']).toBeUndefined()
    expect(manifest.dependencies['@adea-ai/room-designer-scene']).toBeUndefined()
    expect(manifest.dependencies['@adea-ai/character-designer-scene']).toBeUndefined()
    expect(client).toContain('<DesktopWorkspace')
    expect(client).toContain('if (workspaceState)')
    expect(client).toContain('setSession(activeSession)')
    expect(client).toContain('<GlobalWorkspaceRail')
    expect(workspace).toContain('<VirtualUnavailable')
    expect(workspace).toContain('aria-label="Adea workspace controls"')
    expect(client).toContain('Try again')
  })

  test('keeps desktop scene controls inside the canvas group without a status bar', async () => {
    const workspace = await readFile(join(root, 'apps/desktop/src/desktop-workspace.tsx'), 'utf8')
    const styles = await readFile(join(root, 'apps/desktop/src/styles.css'), 'utf8')

    expect(workspace).toContain('<VirtualUnavailable')
    expect(workspace).not.toContain('workspace-camera-slot')
    expect(workspace).not.toContain('workspace-scene-tools-slot')
    expect(workspace).not.toContain('HqRoomScene')
    expect(workspace).not.toContain('workspace-statusbar')
    expect(workspace).not.toContain('<VersionDialog')
    expect(styles).toContain('.workspace-scene-viewport [data-agent-hq-on-screen-controls]')
    expect(styles).toContain('left: 50%')
    expect(styles).toContain('transform: translateX(-50%)')
    expect(styles).not.toContain('--workspace-statusbar-height')
    expect(styles).toContain('.workspace-scene-tools button')
    expect(styles).toContain('width: 100%')
    expect(styles).toContain('max-width: calc(100% - 2.5rem)')
    expect(styles).not.toContain('width: 100vw')
    expect(styles).not.toContain('.workspace-status__dot')
  })

  test('puts optional authentication and identity settings behind the global rail', async () => {
    const desktop = await readFile(join(root, 'apps/desktop/src/main.tsx'), 'utf8')
    const rail = await readFile(
      join(root, 'packages/workspace-ui/src/global-workspace-rail.tsx'),
      'utf8'
    )
    const bootstrapRoute = await readFile(
      join(root, 'apps/web/src/start/routes/api/workspaces/bootstrap.ts'),
      'utf8'
    )

    expect(desktop).toContain('account: {')
    expect(desktop).toContain('onSignIn:')
    expect(desktop).toContain('onSignOut:')
    expect(desktop).toContain("openSettings('account')")
    expect(rail).toContain('<AccountMenu')
    expect(rail).toContain('label="Notifications (coming soon)"')
    expect(bootstrapRoute).toContain('getUserDisplayName')
  })

  test('shares the complete version and changelog dialog across web and desktop', async () => {
    const desktopVersion = await readFile(join(root, 'apps/desktop/src/version-dialog.tsx'), 'utf8')
    const webVersion = await readFile(
      join(root, 'apps/web/src/components/version-dialog.tsx'),
      'utf8'
    )
    const sharedVersion = await readFile(
      join(root, 'packages/ui/src/components/version-dialog.tsx'),
      'utf8'
    )

    expect(desktopVersion).toContain('@adea-ai/ui/components/version-dialog')
    expect(webVersion).toContain('@adea-ai/ui/components/version-dialog')
    expect(sharedVersion).toContain('What changed in this release')
    expect(sharedVersion).toContain('Installed changelog')
    expect(sharedVersion).toContain('View releases')
  })

  test('shares the global workspace rail and keeps account controls in settings', async () => {
    const desktopMain = await readFile(join(root, 'apps/desktop/src/main.tsx'), 'utf8')
    const desktopStyles = await readFile(join(root, 'apps/desktop/src/styles.css'), 'utf8')
    const webWorkspace = await readFile(
      join(root, 'apps/web/src/components/workspace-shell.tsx'),
      'utf8'
    )
    const webNavigation = await readFile(
      join(root, 'apps/web/src/components/workspace-navigation-entry.tsx'),
      'utf8'
    )
    const webLayout = await readFile(join(root, 'apps/web/src/start/routes/__root.tsx'), 'utf8')
    const webStyles = await readFile(join(root, 'apps/web/src/start/globals.css'), 'utf8')
    const globalRail = await readFile(
      join(root, 'packages/workspace-ui/src/global-workspace-rail.tsx'),
      'utf8'
    )
    const accountMenu = await readFile(
      join(root, 'packages/workspace-ui/src/account-menu.tsx'),
      'utf8'
    )

    expect(desktopMain).toContain('<SoundProvider>')
    expect(desktopMain).toContain('<ThemeProvider>')
    expect(webNavigation).toContain('accountLabel=')
    expect(globalRail).toContain('aria-label="Global navigation"')
    expect(globalRail).toContain('label="Virtual view"')
    expect(globalRail).toContain('label="Chat view"')
    expect(globalRail).toContain('label="Plugins"')
    expect(accountMenu).toContain('aria-label="User settings"')
    expect(accountMenu).toContain('Updates')
    expect(desktopMain).toContain('onOpenUpdates: () => setUpdatesOpen(true)')
    expect(webWorkspace).not.toContain('workspace-statusbar')
    expect(desktopStyles).toContain('- 0.45rem')
    expect(desktopStyles).toContain('env(safe-area-inset-top)')
    expect(webStyles).toContain('env(safe-area-inset-top)')
    expect(webStyles).toContain('max-width: calc(100% - 2.5rem)')
    expect(webStyles).not.toContain('max-width: calc(100vw - 2.5rem)')
    expect(webLayout).toContain("name: 'theme-color'")
    expect(webWorkspace).toContain('<VirtualUnavailable')
  })

  test('deduplicates React across the packaged spatial runtime', async () => {
    const viteConfig = await readFile(join(root, 'apps/desktop/vite.config.ts'), 'utf8')

    expect(viteConfig).toContain("dedupe: ['react', 'react-dom']")
  })

  test('registers the client half of the desktop callback handoff', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
    const client = await readFile(join(root, 'apps/desktop/src/main.tsx'), 'utf8')

    // URL-scheme registration is a release-pipeline concern (documented in
    // docs/specs/desktop-auth.md); the client half stands on its own here.
    expect(manifest.dependencies['@adea-ai/auth']).toBe('workspace:*')
    expect(client).not.toContain('@adea-ai/auth/server')
    expect(client).not.toContain('server-only')
    expect(client).toContain('createDesktopHttpSessionBroker')
    expect(client).toContain('desktop_user_session_save')
  })

  test('uses one shared visual shell for browser and desktop authentication', async () => {
    const desktop = await readFile(join(root, 'apps/desktop/src/main.tsx'), 'utf8')
    const desktopStyles = await readFile(join(root, 'apps/desktop/src/styles.css'), 'utf8')
    const web = await readFile(join(root, 'apps/web/src/start/routes/auth/sign-in.tsx'), 'utf8')
    const webStyles = await readFile(join(root, 'apps/web/src/start/globals.css'), 'utf8')
    const sharedStyles = await readFile(join(root, 'packages/ui/src/styles/auth-shell.css'), 'utf8')

    expect(desktopStyles).toContain("@import '@adea-ai/ui/auth-shell.css'")
    expect(webStyles).toContain("@import '@adea-ai/ui/auth-shell.css'")
    expect(desktop).toContain('className="auth-shell"')
    expect(web).toContain('className="auth-shell"')
    expect(sharedStyles).toContain('.auth-panel')
    expect(sharedStyles).toContain('.auth-title')
    expect(sharedStyles).toContain('--auth-accent: var(--hq-shell-accent)')
    expect(sharedStyles).toContain('--auth-background: var(--hq-shell-background)')
    expect(desktopStyles).toContain('color: var(--hq-shell-foreground)')
    expect(desktopStyles).toContain('background: var(--hq-shell-background)')
  })

  test('provides cloud authorization, exchange, refresh, logout, and revocation handlers', async () => {
    for (const endpoint of ['authorize', 'exchange', 'refresh', 'logout', 'revoke']) {
      const route = await readFile(
        join(root, `apps/web/src/start/routes/api/auth/desktop/${endpoint}.ts`),
        'utf8'
      )
      // Every desktop endpoint is a dynamic server route. The CORS endpoints
      // (exchange/refresh/logout/revoke) add a preflight; authorize is a
      // top-level browser navigation and therefore has none.
      expect(route).toContain('createFileRoute')
      expect(route).toContain('server:')
      if (endpoint !== 'authorize') expect(route).toContain('OPTIONS')
    }

    const schema = await readFile(join(root, 'packages/db/src/schema/desktop-auth.ts'), 'utf8')
    expect(schema).toContain("'code_digest'")
    expect(schema).toContain("'credential_digest'")
    expect(schema).not.toMatch(/text\(["'](?:code|credential)["']\)/u)
  })

  test('provides an accessible browser sign-in handoff for desktop authorization', async () => {
    const authorize = await readFile(
      join(root, 'apps/web/src/start/routes/api/auth/desktop/authorize.ts'),
      'utf8'
    )
    const page = await readFile(join(root, 'apps/web/src/start/routes/auth/sign-in.tsx'), 'utf8')
    const form = await readFile(join(root, 'apps/web/src/components/sign-in-form.tsx'), 'utf8')
    const completionPage = await readFile(
      join(root, 'apps/web/src/start/routes/auth/desktop/complete.tsx'),
      'utf8'
    )
    const completionClient = await readFile(
      join(root, 'apps/web/src/components/desktop-auth-complete.tsx'),
      'utf8'
    )

    expect(authorize).toContain('createDesktopSignInUrl')
    expect(authorize).toContain('createDesktopCompletionUrl')
    expect(authorize).not.toContain('Authentication required')
    expect(page).toContain('normalizeDesktopAuthorizationReturnTo')
    expect(form).toContain('htmlFor="email"')
    expect(form).toContain('htmlFor="password"')
    expect(form).toContain('aria-live="polite"')
    expect(form).toContain('createNeonClientAdapter')
    expect(completionPage).toContain('className="auth-shell"')
    expect(completionClient).toContain('You can close this tab')
    expect(completionClient).toContain('parseDesktopCallbackFragment')
    expect(completionClient).toContain('window.history.replaceState')
  })

  test('keeps provider and server-only modules out of the packaged JavaScript', async () => {
    const assets = join(root, 'apps/desktop/dist/assets')
    const scripts = (await readdir(assets)).filter((file) => file.endsWith('.js'))
    expect(scripts.length).toBeGreaterThan(0)
    const bundle = (
      await Promise.all(scripts.map((file) => readFile(join(assets, file), 'utf8')))
    ).join('\n')
    expect(bundle).not.toContain('@neondatabase/auth')
    expect(bundle).not.toContain('node:crypto')
    expect(bundle).not.toContain('server-only')
    expect(bundle).not.toContain('@adea-ai/db')
  })
})
