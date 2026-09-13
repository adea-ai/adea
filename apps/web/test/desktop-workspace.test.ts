import { describe, expect, test } from 'bun:test'

import {
  applyDesktopWorkspaceCors,
  desktopTrustedOrigins,
  desktopWorkspacePreflight,
  rejectUntrustedDesktopWorkspaceRequest,
  trustedDesktopWorkspaceRequest,
} from '../src/server/desktop-workspace'

const SHELL_ORIGIN = 'http://127.0.0.1:4789'
const trustedOrigins = [SHELL_ORIGIN, 'http://127.0.0.1:1420']

function request(origin: string, client = 'desktop') {
  return new Request('https://hq.example/api/workspaces/bootstrap', {
    headers: { origin, 'x-adea-client': client },
    method: 'POST',
  })
}

describe('desktop workspace HTTP boundary', () => {
  test('trusts the shell loopback origin and the fixed local development origin', () => {
    const origins = desktopTrustedOrigins({ NODE_ENV: 'production' })

    // The Electrobun shell's page origin comes first as the live desktop origin.
    expect(origins[0]).toBe(SHELL_ORIGIN)
    expect(origins).toContain('http://127.0.0.1:1420')
    // The previous shell's URL scheme is a clean slate.
    expect(origins).not.toContain('tauri://localhost')
    expect(
      desktopTrustedOrigins({
        DESKTOP_AUTH_TRUSTED_ORIGINS: SHELL_ORIGIN,
        NODE_ENV: 'production',
      })
    ).toContain('http://127.0.0.1:1420')
  })

  test('refuses the previous shell URL scheme in configured origins', () => {
    expect(() =>
      desktopTrustedOrigins({
        DESKTOP_AUTH_TRUSTED_ORIGINS: 'tauri://localhost',
        NODE_ENV: 'production',
      })
    ).toThrow('Desktop auth trusted origins are invalid')
  })

  test('recognizes only an explicitly marked request from a trusted packaged origin', () => {
    expect(trustedDesktopWorkspaceRequest(request(SHELL_ORIGIN), trustedOrigins)).toBe(true)
    expect(
      trustedDesktopWorkspaceRequest(request('https://hq.example', 'browser'), trustedOrigins)
    ).toBe(false)
    expect(trustedDesktopWorkspaceRequest(request('https://evil.example'), trustedOrigins)).toBe(
      false
    )
  })

  test('rejects untrusted desktop markers before workspace provisioning', async () => {
    expect(rejectUntrustedDesktopWorkspaceRequest(request(SHELL_ORIGIN), trustedOrigins)).toBeNull()
    const rejected = rejectUntrustedDesktopWorkspaceRequest(
      request('https://evil.example'),
      trustedOrigins
    )
    expect(rejected?.status).toBe(403)
    expect(rejected?.headers.get('access-control-allow-origin')).toBeNull()
    expect(await rejected?.json()).toEqual({
      code: 'workspace_unavailable',
      message: 'Workspace unavailable',
    })
  })

  test('limits preflight and response CORS to trusted desktop origins', () => {
    const preflight = desktopWorkspacePreflight(request(SHELL_ORIGIN), trustedOrigins)
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(SHELL_ORIGIN)
    expect(preflight.headers.get('access-control-allow-headers')).toContain(
      'X-Adea-Temporary-Session'
    )

    const response = applyDesktopWorkspaceCors(
      Response.json({ ok: true }),
      request(SHELL_ORIGIN),
      trustedOrigins
    )
    expect(response.headers.get('access-control-allow-origin')).toBe(SHELL_ORIGIN)
    expect(response.headers.get('vary')).toContain('Origin')

    const untrustedPreflight = desktopWorkspacePreflight(
      request('https://evil.example'),
      trustedOrigins
    )
    expect(untrustedPreflight.status).toBe(403)
    expect(untrustedPreflight.headers.get('access-control-allow-origin')).toBeNull()
  })
})
