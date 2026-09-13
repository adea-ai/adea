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

describe('desktop packaging and single-UI client boundary', () => {
  test('builds the single UI from the web workspace before the shell bundles it', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
    const clientBuild = await readFile(join(root, 'apps/desktop/scripts/client.mjs'), 'utf8')
    const shellRunner = await readFile(join(root, 'apps/desktop/scripts/shell.mjs'), 'utf8')
    const webBuild = await readFile(join(root, 'apps/web/vite.desktop.config.ts'), 'utf8')

    expect(manifest.scripts['shell:client:build']).toBe('bun scripts/client.mjs')
    expect(manifest.scripts['shell:build']).toBe('bun scripts/shell.mjs build')
    // The desktop lane no longer owns a client dependency graph.
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.devDependencies).toBeUndefined()
    // The client build is the web app's own build pipeline, filtered to build
    // the workspace packages the web app consumes first.
    expect(clientBuild).toContain("'turbo', 'run', 'build', '--filter=@adea-ai/web^...'")
    expect(clientBuild).toContain("'desktop:build'")
    expect(clientBuild).toContain('ADEA_DESKTOP_CLOUD_ORIGIN')
    // The SPA output is what the shell's static server serves; no second client.
    expect(webBuild).toContain('spa: { enabled: true')
    expect(webBuild).toContain("outDir: 'dist-desktop'")
    expect(webBuild).toContain('forbiddenClientModule')
    // The client build runs before the shell bundling step.
    expect(shellRunner).toContain("['run', 'shell:client:build']")
    expect(shellRunner.indexOf("['run', 'shell:client:build']")).toBeLessThan(
      shellRunner.indexOf("['--bun', 'electrobun'")
    )
    // The client is always served from the bundle; no remote application URL.
    expect(shellRunner).not.toContain('ADEA_WEB_URL')
    expect(clientBuild).not.toContain('ADEA_WEB_URL')
  })

  test('has no desktop-only component or stylesheet fork', async () => {
    expect(existsSync(join(root, 'apps/desktop/src'))).toBe(false)
    expect(existsSync(join(root, 'apps/desktop/vite.config.ts'))).toBe(false)
    expect(existsSync(join(root, 'apps/desktop/index.html'))).toBe(false)

    // The scene shell rules the deleted desktop stylesheet duplicated live in
    // the one shared stylesheet the web app loads.
    const webStyles = await readFile(join(root, 'apps/web/src/start/globals.css'), 'utf8')
    expect(webStyles).toContain('.workspace-scene-viewport [data-agent-hq-on-screen-controls]')
    expect(webStyles).toContain('- 0.45rem')
    expect(webStyles).toContain('env(safe-area-inset-top)')
    expect(webStyles).toContain('max-width: calc(100% - 2.5rem)')
    expect(webStyles).not.toContain('width: 100vw')

    // The desktop runtime renders the shared navigation; only the start
    // surface is flag-guarded, and it uses shared auth-shell classes.
    const desktopEntry = await readFile(
      join(root, 'apps/web/src/components/desktop-workspace-entry.tsx'),
      'utf8'
    )
    expect(desktopEntry).toContain('<WorkspaceNavigation')
    expect(desktopEntry).toContain('className="auth-shell"')
    expect(desktopEntry).not.toContain('<style')
    expect(desktopEntry).not.toContain('.css')
  })

  test('enters the single-UI workspace after guest bootstrap', async () => {
    const client = await readFile(
      join(root, 'apps/web/src/components/desktop-workspace-entry.tsx'),
      'utf8'
    )
    const navigation = await readFile(
      join(root, 'apps/web/src/components/workspace-navigation.tsx'),
      'utf8'
    )
    const workspace = await readFile(
      join(root, 'apps/web/src/components/workspace-shell.tsx'),
      'utf8'
    )

    expect(client).toContain('bootstrapDesktopWorkspace')
    expect(client).toContain('if (!workspaceState || !activeWorkspace)')
    expect(client).toContain('setSession(activeSession)')
    expect(client).toContain('Try again')
    expect(navigation).toContain('<GlobalWorkspaceRail')
    expect(navigation).toContain('<SpatialWorkspace')
    expect(workspace).toContain('<VirtualUnavailable')
    expect(workspace).toContain('aria-label="Adea workspace controls"')
  })

  test('puts optional authentication and identity settings behind the global rail', async () => {
    const desktop = await readFile(
      join(root, 'apps/web/src/components/desktop-workspace-entry.tsx'),
      'utf8'
    )
    const navigation = await readFile(
      join(root, 'apps/web/src/components/workspace-navigation.tsx'),
      'utf8'
    )
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
    expect(navigation).toContain("openSettings('account')")
    expect(rail).toContain('<AccountMenu')
    expect(rail).toContain('label="Notifications (coming soon)"')
    expect(bootstrapRoute).toContain('getUserDisplayName')
  })

  test('shares the complete version and changelog dialog across web and desktop', async () => {
    const navigation = await readFile(
      join(root, 'apps/web/src/components/workspace-navigation.tsx'),
      'utf8'
    )
    const webVersion = await readFile(
      join(root, 'apps/web/src/components/version-dialog.tsx'),
      'utf8'
    )
    const sharedVersion = await readFile(
      join(root, 'packages/ui/src/components/version-dialog.tsx'),
      'utf8'
    )

    // One dialog: the desktop update surface is the flag-guarded adapter on the
    // same component the web app renders.
    expect(webVersion).toContain('@adea-ai/ui/components/version-dialog')
    expect(webVersion).toContain('isDesktopRuntime')
    expect(navigation).toContain('<VersionDialog')
    expect(sharedVersion).toContain('What changed in this release')
    expect(sharedVersion).toContain('Installed changelog')
    expect(sharedVersion).toContain('View releases')
    expect(existsSync(join(root, 'apps/desktop/src/version-dialog.tsx'))).toBe(false)
  })

  test('shares the global workspace rail and keeps account controls in settings', async () => {
    const navigation = await readFile(
      join(root, 'apps/web/src/components/workspace-navigation.tsx'),
      'utf8'
    )
    const desktopEntry = await readFile(
      join(root, 'apps/web/src/components/desktop-workspace-entry.tsx'),
      'utf8'
    )
    const workspaceMount = await readFile(
      join(root, 'apps/web/src/start/workspace-mount.tsx'),
      'utf8'
    )
    const webStyles = await readFile(join(root, 'apps/web/src/start/globals.css'), 'utf8')
    const globalRail = await readFile(
      join(root, 'packages/workspace-ui/src/global-workspace-rail.tsx'),
      'utf8'
    )
    const accountMenu = await readFile(
      join(root, 'packages/workspace-ui/src/account-menu.tsx'),
      'utf8'
    )

    expect(workspaceMount).toContain('<SoundProvider>')
    expect(workspaceMount).toContain('<ThemeProvider>')
    expect(navigation).toContain('WorkspaceSettingsOverlay')
    expect(globalRail).toContain('aria-label="Global navigation"')
    expect(globalRail).toContain('label="Virtual view"')
    expect(globalRail).toContain('label="Chat view"')
    expect(globalRail).toContain('label="Plugins"')
    expect(accountMenu).toContain('aria-label="User settings"')
    expect(accountMenu).toContain('Updates')
    expect(desktopEntry).toContain('onOpenUpdates: () => setUpdatesOpen(true)')
    expect(webStyles).toContain('env(safe-area-inset-top)')
    expect(webStyles).toContain('max-width: calc(100% - 2.5rem)')
    expect(webStyles).not.toContain('max-width: calc(100vw - 2.5rem)')
  })

  test('deduplicates React across the packaged spatial runtime', async () => {
    const viteConfig = await readFile(join(root, 'apps/web/vite.desktop.config.ts'), 'utf8')

    expect(viteConfig).toContain("dedupe: ['react', 'react-dom']")
  })

  test('registers the client half of the desktop callback handoff', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'apps/web/package.json'), 'utf8'))
    const runtime = await readFile(join(root, 'apps/web/src/lib/desktop-runtime.ts'), 'utf8')

    // URL-scheme registration is a release-pipeline concern (documented in
    // docs/specs/desktop-auth.md); the client half stands on its own here.
    expect(manifest.dependencies['@adea-ai/auth']).toBe('workspace:*')
    expect(runtime).not.toContain('@adea-ai/auth/server')
    expect(runtime).not.toContain('server-only')
    expect(runtime).toContain('createDesktopHttpSessionBroker')
    expect(runtime).toContain('desktop_user_session_save')
  })

  test('uses one shared visual shell for browser and desktop authentication', async () => {
    const desktop = await readFile(
      join(root, 'apps/web/src/components/desktop-workspace-entry.tsx'),
      'utf8'
    )
    const web = await readFile(join(root, 'apps/web/src/start/routes/auth/sign-in.tsx'), 'utf8')
    const webStyles = await readFile(join(root, 'apps/web/src/start/globals.css'), 'utf8')
    const sharedStyles = await readFile(join(root, 'packages/ui/src/styles/auth-shell.css'), 'utf8')

    expect(webStyles).toContain("@import '@adea-ai/ui/auth-shell.css'")
    expect(desktop).toContain('className="auth-shell"')
    expect(web).toContain('className="auth-shell"')
    expect(sharedStyles).toContain('.auth-panel')
    expect(sharedStyles).toContain('.auth-title')
    expect(sharedStyles).toContain('.auth-status')
    expect(sharedStyles).toContain('--auth-accent: var(--hq-shell-accent)')
    expect(sharedStyles).toContain('--auth-background: var(--hq-shell-background)')
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

  test('keeps provider and server-only modules out of the desktop client graph', async () => {
    const sources = [
      'apps/web/src/lib/desktop-bridge.ts',
      'apps/web/src/lib/desktop-local-content.ts',
      'apps/web/src/lib/desktop-platform-services.ts',
      'apps/web/src/lib/desktop-private-content.ts',
      'apps/web/src/lib/desktop-runtime.ts',
      'apps/web/src/lib/desktop-update.ts',
      'apps/web/src/lib/desktop-workspace-session.ts',
      'apps/web/src/components/desktop-workspace-entry.tsx',
      'apps/web/src/components/workspace-navigation.tsx',
      'apps/web/src/components/workspace-navigation-entry.tsx',
    ]
    const violations: string[] = []
    for (const file of sources) {
      const source = await readFile(join(root, file), 'utf8')
      for (const token of ['@neondatabase/auth', 'node:crypto', 'server-only', '@adea-ai/db']) {
        if (source.includes(token)) violations.push(`${file}: ${token}`)
      }
    }
    expect(violations).toEqual([])

    // The desktop build enforces the same boundary mechanically; this test
    // pins the plugin wiring in the build that produces the shell's client.
    const webBuild = await readFile(join(root, 'apps/web/vite.desktop.config.ts'), 'utf8')
    expect(webBuild).toContain('protectClientGraph')
    expect(webBuild).toContain('Server-only or framework-server module in client')
  })
})
