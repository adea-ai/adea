/*
 * Device workspace scope selection (ADR 0011): the client asks the shell to
 * select a workspace's Dev scope with the credential that proves membership,
 * and the Dev runtime reads the shell scope only AFTER that selection settles.
 * A refusal or a scope for another workspace keeps Dev unavailable (fail
 * closed) without throwing into the workspace switch.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import type { DesktopShell } from '../src/lib/desktop-bridge'
import { createDesktopDevRuntimeService } from '../src/lib/desktop-dev-runtime'
import { createDesktopDevScopeSelector, devScopeCredential } from '../src/lib/desktop-dev-scope'

const WORKSPACE_A = '00000000-0000-4000-8000-0000000000a1'
const WORKSPACE_B = '00000000-0000-4000-8000-0000000000b2'
const local = {
  accountId: '00000000-0000-4000-8000-000000000001',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const TEMPORARY = `adea_tmp_${'g'.repeat(43)}`

/** A fake shell bridge that records call order and holds one active scope. */
function fakeShell(options: { refuse?: string } = {}) {
  const calls: string[] = []
  let active = { ...local, workspaceId: '00000000-0000-4000-8000-0000000000ff' }
  let releaseSelect: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    releaseSelect = resolve
  })
  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    calls.push(cmd)
    if (cmd === 'desktop_identity_select_workspace') {
      await gate
      if (options.refuse) throw new Error(`${options.refuse}: refused by the shell`)
      active = { ...local, workspaceId: String(args?.workspaceId) }
      calls.push('selected')
      return { scope: active, kind: 'device' }
    }
    if (cmd === 'desktop_identity_scope') return active
    throw new Error(`unexpected ${cmd}`)
  }
  const bridge = {
    invoke,
    listen: async () => () => undefined,
    devExecute: async () => ({ ok: true }),
  } as unknown as DesktopShell
  return { bridge, calls, invoke, release: () => releaseSelect?.() }
}

const originalWindow = (globalThis as { window?: unknown }).window
afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
})
function install(bridge: DesktopShell) {
  ;(globalThis as { window?: unknown }).window = { __adeaDesktop: bridge }
}

describe('desktop dev scope selection', () => {
  test('prefers the desktop session and falls back to the guest credential', () => {
    const session = { credential: 'c'.repeat(43), sessionId: 's'.repeat(24), expiresAt: 'x' }
    expect(devScopeCredential(session, TEMPORARY)).toEqual({ kind: 'desktop', session })
    expect(devScopeCredential(undefined, TEMPORARY)).toEqual({
      kind: 'temporary',
      credential: TEMPORARY,
    })
    expect(devScopeCredential(undefined, null)).toBeUndefined()
  })

  test('the runtime re-reads the shell scope only after the selection settles', async () => {
    const shell = fakeShell()
    install(shell.bridge)
    const selector = createDesktopDevScopeSelector({
      credential: () => ({ kind: 'temporary', credential: TEMPORARY }),
      invoke: shell.invoke as never,
    })
    const runtime = createDesktopDevRuntimeService({
      scopeSelection: selector.ensure(WORKSPACE_A),
      expectedWorkspaceId: WORKSPACE_A,
    })
    await Promise.resolve()
    // Nothing reads the scope while the selection is pending.
    expect(shell.calls).toEqual(['desktop_identity_select_workspace'])
    expect(runtime.state()).toMatchObject({ status: 'unavailable' })

    shell.release()
    await runtime.ready
    expect(shell.calls).toEqual([
      'desktop_identity_select_workspace',
      'selected',
      'desktop_identity_scope',
    ])
    expect(runtime.state()).toEqual({ status: 'ready' })
    expect(runtime.preferenceScope?.()).toEqual({ ...local, workspaceId: WORKSPACE_A })

    // `ensure` for the same workspace reuses the selection (no second call);
    // a different workspace selects again.
    await selector.ensure(WORKSPACE_A)
    expect(shell.calls.filter((call) => call === 'desktop_identity_select_workspace')).toHaveLength(
      1
    )
    await selector.ensure(WORKSPACE_B)
    expect(shell.calls.filter((call) => call === 'desktop_identity_select_workspace')).toHaveLength(
      2
    )
  })

  test('a refused selection keeps Dev unavailable and never reads the scope', async () => {
    const shell = fakeShell({ refuse: 'unauthorized' })
    install(shell.bridge)
    shell.release()
    const selector = createDesktopDevScopeSelector({
      credential: () => ({ kind: 'temporary', credential: TEMPORARY }),
      invoke: shell.invoke as never,
    })
    const selection = await selector.select(WORKSPACE_A)
    expect(selection).toMatchObject({ ok: false, code: 'unauthorized', workspaceId: WORKSPACE_A })

    const runtime = createDesktopDevRuntimeService({
      scopeSelection: Promise.resolve(selection),
      expectedWorkspaceId: WORKSPACE_A,
    })
    await runtime.ready
    expect(shell.calls).not.toContain('desktop_identity_scope')
    expect(runtime.state()).toMatchObject({ status: 'unavailable' })
    expect(runtime.preferenceScope?.()).toBeUndefined()
  })

  test('no credential resolves to a typed refusal without calling the shell', async () => {
    const shell = fakeShell()
    const selector = createDesktopDevScopeSelector({
      credential: () => undefined,
      invoke: shell.invoke as never,
    })
    expect(await selector.select(WORKSPACE_A)).toMatchObject({
      ok: false,
      code: 'unauthenticated',
    })
    expect(shell.calls).toEqual([])
  })

  test('a shell scope for another workspace keeps Dev unavailable', async () => {
    const shell = fakeShell()
    install(shell.bridge)
    shell.release()
    const runtime = createDesktopDevRuntimeService({ expectedWorkspaceId: WORKSPACE_B })
    await runtime.ready
    expect(shell.calls).toEqual(['desktop_identity_scope'])
    expect(runtime.state()).toMatchObject({ status: 'unavailable' })
  })
})
