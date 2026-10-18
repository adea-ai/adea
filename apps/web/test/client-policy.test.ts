import { describe, expect, test } from 'bun:test'
import {
  desktopOnlyClientModule,
  forbiddenClientModule,
  PRIVATE_ENV_NAMES,
  PUBLIC_ENV_NAMES,
} from '../start/client-policy.mjs'

describe('pure browser dependency boundaries', () => {
  test.each([
    '/repo/node_modules/next/dist/server.js',
    'next/headers',
    'next/server?client',
    'server-only',
    '/repo/packages/db/src/connection.ts',
    '/repo/packages/db/dist/index.js',
    '/node_modules/@adea-ai/db/index.js',
    '/node_modules/@adea-ai/sdk/index.js',
    '/node_modules/@adea-ai/contracts/index.js',
    '/repo/apps/web/src/server/auth.ts',
    '/repo/packages/auth/src/config.ts',
    '/repo/packages/auth/src/better-auth-server.ts',
    '/node_modules/@adea-ai/auth/dist/server.js',
    '/node_modules/@adea-ai/auth/dist/better-auth-server.js',
    '/node_modules/better-auth/dist/index.mjs',
    '/node_modules/better-auth/dist/api/index.mjs',
    '/repo/apps/web/src/start/worker.ts',
    '/node_modules/react/index.js',
    '/node_modules/react-dom/client.js',
    '/node_modules/scheduler/index.js',
    '/node_modules/@types/react/index.d.ts',
    '/node_modules/@radix-ui/react-dialog/index.js',
    '/node_modules/@base-ui/react/index.js',
    '/node_modules/next-themes/index.js',
    '/node_modules/nuqs/index.js',
    '/node_modules/lucide-react/index.js',
    '/node_modules/@tanstack/react-query/index.js',
  ])('rejects host-only or incompatible dependency %s', (path) =>
    expect(forbiddenClientModule(path)).toBe(true)
  )

  test.each([
    '/repo/node_modules/solid-js/web/dist/web.js',
    '/repo/packages/types/src/index.ts',
    '/repo/packages/auth/src/session.ts',
    '/repo/node_modules/@adea-ai/ui/dist/index.js',
    '/repo/node_modules/better-auth/dist/client/index.mjs',
    '/repo/node_modules/@tanstack/solid-query/index.js',
    '/repo/apps/web/src/components/workspace.tsx',
  ])('retains permitted browser dependency %s', (path) =>
    expect(forbiddenClientModule(path)).toBe(false)
  )

  test('normalizes Windows separators without broad substring rejection', () => {
    expect(forbiddenClientModule('C:\\repo\\packages\\db\\src\\index.ts')).toBe(true)
    expect(forbiddenClientModule('/repo/server-only-helper/index.js')).toBe(false)
    expect(forbiddenClientModule('/repo/node_modules/reactive/index.js')).toBe(false)
  })

  test.each(['desktop-workspace-entry', 'desktop-first-run-chat', 'version-dialog'])(
    'identifies native-only host %s',
    (name) => {
      expect(desktopOnlyClientModule(`/repo/apps/web/src/components/${name}.tsx`)).toBe(true)
      expect(desktopOnlyClientModule(`/repo/apps/web/src/components/${name}-helper.tsx`)).toBe(
        false
      )
    }
  )

  test('does not classify shared browser UI as a desktop-only host', () => {
    expect(desktopOnlyClientModule('/repo/apps/web/src/components/workspace-shell.tsx')).toBe(false)
    expect(
      desktopOnlyClientModule('C:\\repo\\apps\\web\\src\\components\\version-dialog.tsx')
    ).toBe(true)
  })

  test('keeps private bindings out of the explicit public substitution list', () => {
    expect(PUBLIC_ENV_NAMES).toEqual([
      'ADEA_PUBLIC_WORLD_URL',
      'ADEA_PUBLIC_HQ_URL',
      'ADEA_PUBLIC_SCENE_TELEMETRY_ENDPOINT',
      'ADEA_PUBLIC_DEPLOY_GIT_COMMIT_SHA',
    ])
    for (const name of PRIVATE_ENV_NAMES) expect(PUBLIC_ENV_NAMES).not.toContain(name)
    for (const name of [
      'DATABASE_URL',
      'CONTROL_PLANE_API_TOKEN',
      'CONTROL_PLANE_SIGNING_KEY',
      'NEON_AUTH_COOKIE_SECRET',
      'AUTH_SECRET',
      'AUTH_DATABASE_URL',
    ])
      expect(PRIVATE_ENV_NAMES).toContain(name)
  })
})
