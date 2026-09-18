// Issue #396 shell-integration contract: content-addressed wrappers, the
// positive-allowlist spawn environment, authenticated OSC 133/7 observation
// frames (mac over terminal/generation/kind/nonce/digest), nonce replay
// rejection, OSC 52 denial, payload bounds, rate limiting, byte-exact
// passthrough, and containment-proven history deletion.
import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ADEA_TERMINAL_ENV_KEYS,
  buildTerminalEnv,
  deleteWorktreeHistory,
  hookMacMessage,
  installWrapper,
  parseShellKind,
  resolveWorktreeHistoryFile,
  selectShellFeatures,
  SHELL_WRAPPER_PROTOCOL_VERSION,
  wrapperContent,
  type ShellObservation,
} from '../shell/src/dev-runtime/terminal/shell-integration'
import {
  createShellIntegrationObserver,
  type ShellIntegrationObserver,
} from '../shell/src/dev-runtime/terminal/shell-integration'

const terminalId = '00000000-0000-4000-8000-0000000000d4'
const generation = 3
const hookKey = new Uint8Array(32).fill(7)

function payload(kind: string, fields: Record<string, unknown>, nonce: string): string {
  return JSON.stringify({ v: SHELL_WRAPPER_PROTOCOL_VERSION, k: kind, n: nonce, ...fields })
}

function frameFor(
  kind: string,
  fields: Record<string, unknown>,
  nonce: string,
  key: Uint8Array = hookKey,
  frameGeneration = generation,
  frameTerminalId = terminalId
): Uint8Array {
  const payloadText = payload(kind, fields, nonce)
  const payloadB64 = Buffer.from(payloadText, 'utf8').toString('base64url')
  const mac = createHmac('sha256', key)
    .update(
      hookMacMessage({
        terminalId: frameTerminalId,
        generation: frameGeneration,
        kind,
        nonce,
        payloadSha256: createHash('sha256').update(payloadText, 'utf8').digest('hex'),
      }),
      'utf8'
    )
    .digest('base64url')
  return new TextEncoder().encode(`\u001b]133;adea;${payloadB64};${mac}\u0007`)
}

type ObserverHarness = {
  observer: ShellIntegrationObserver
  observations: ShellObservation[]
  violations: Array<{ kind: string; detail: string }>
}

function harness(overrides?: { hookKey?: Uint8Array; generation?: number }): ObserverHarness {
  const observations: ShellObservation[] = []
  const violations: Array<{ kind: string; detail: string }> = []
  const observer = createShellIntegrationObserver({
    terminalId,
    generation: overrides?.generation ?? generation,
    hookKey: overrides?.hookKey ?? hookKey,
    maxFramesPerSecond: 3,
    onObservation: (observation) => observations.push(observation),
    onViolation: (violation) => violations.push(violation),
  })
  return { observer, observations, violations }
}

describe('shell integration wrappers', () => {
  test('parses shell kinds from versioned and store-prefixed paths', () => {
    expect(parseShellKind('/bin/zsh')).toBe('zsh')
    expect(parseShellKind('/opt/homebrew/bin/zsh-5.9')).toBe('zsh')
    expect(parseShellKind('/bin/bash')).toBe('bash')
    expect(parseShellKind('/usr/bin/fish')).toBe('fish')
    expect(parseShellKind('/bin/sh')).toBe('unknown')
  })

  test('feature selection is a positive allowlist of launch intent', () => {
    expect(
      selectShellFeatures({
        shellKind: 'zsh',
        wantsCommandMarkers: true,
        reportsCwd: true,
        wantsHistory: true,
      })
    ).toEqual(['markers', 'cwd', 'history'])
    expect(
      selectShellFeatures({
        shellKind: 'unknown',
        wantsCommandMarkers: true,
        reportsCwd: true,
        wantsHistory: true,
      })
    ).toEqual([])
  })

  test('wrapper content is deterministic per shell and feature set and omits secrets', () => {
    const features = selectShellFeatures({
      shellKind: 'zsh',
      wantsCommandMarkers: true,
      reportsCwd: true,
      wantsHistory: true,
    })
    const first = wrapperContent('zsh', features)
    const second = wrapperContent('zsh', features)
    expect(first).toBe(second)
    expect(first).not.toContain('hook-key') // secrets ride env, never file content
    expect(wrapperContent('unknown', [])).toBe('')
    expect(wrapperContent('fish', ['markers'])).toContain('fish_preexec')
  })

  test('install is content-addressed, owner-only, and idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-wrap-'))
    try {
      const features = ['markers', 'cwd', 'history'] as const
      const first = installWrapper({ runtimeRoot: root, shellKind: 'zsh', features })
      expect(first.reused).toBe(false)
      expect(statSync(first.path).mode & 0o777).toBe(0o600)
      const second = installWrapper({ runtimeRoot: root, shellKind: 'zsh', features })
      expect(second.path).toBe(first.path)
      expect(second.reused).toBe(true)
      expect(second.contentSha256).toBe(first.contentSha256)
      // A different feature set is a different content address.
      const narrower = installWrapper({
        runtimeRoot: root,
        shellKind: 'zsh',
        features: ['markers'],
      })
      expect(narrower.path).not.toBe(first.path)
      expect(() =>
        installWrapper({ runtimeRoot: root, shellKind: 'unknown', features: [] })
      ).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('spawn environment is an allowlist fence plus reviewed Adea keys only', () => {
    const env = buildTerminalEnv(
      {
        HOME: '/Users/dev',
        PATH: '/usr/bin',
        MY_SECRET_TOKEN: 'do-not-inherit',
        NODE_ENV: 'drop-me',
        HISTFILE: '/Users/dev/.zsh_history', // user's own value must win
      },
      {
        terminalId,
        generation,
        hookKey,
        features: ['markers', 'history'],
        histFile: '/runtime/history/abc/zsh_history',
      }
    )
    expect(env.HOME).toBe('/Users/dev')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.MY_SECRET_TOKEN).toBeUndefined()
    expect(env.NODE_ENV).toBeUndefined()
    expect(env.TERM).toBe('xterm-256color')
    for (const key of ADEA_TERMINAL_ENV_KEYS) expect(env[key]).toBeDefined()
    // The allowlist fence drops inherited keys wholesale, so an inherited
    // HISTFILE cannot leak in; reviewed project additions applied last win.
    expect(env.HISTFILE).toBe('/runtime/history/abc/zsh_history')
    const withProjectHist = buildTerminalEnv(
      { HOME: '/Users/dev' },
      {
        terminalId,
        generation,
        hookKey,
        features: ['history'],
        histFile: '/runtime/history/abc/zsh_history',
        projectEnv: { HISTFILE: '/Users/dev/.zsh_history' },
      }
    )
    expect(withProjectHist.HISTFILE).toBe('/Users/dev/.zsh_history') // check-before-set
    // Without a caller-supplied HISTFILE, the worktree file is used.
    const withoutUser = buildTerminalEnv(
      { HOME: '/Users/dev' },
      {
        terminalId,
        generation,
        hookKey,
        features: ['history'],
        histFile: '/runtime/history/abc/zsh_history',
      }
    )
    expect(withoutUser.HISTFILE).toBe('/runtime/history/abc/zsh_history')
  })
})

describe('authenticated shell observations', () => {
  test('verifies well-formed frames, records observations, strips protocol bytes', () => {
    const h = harness()
    const plain = new TextEncoder().encode('$ ')
    const out1 = h.observer.feed(
      frameFor('preexec', { c: Buffer.from('cargo test').toString('base64') }, 'aa11')
    )
    const out2 = h.observer.feed(concat(plain, frameFor('precmd', { e: 0 }, 'bb22')))
    expect(h.observations).toEqual([
      { kind: 'preexec', command: Buffer.from('cargo test').toString('base64'), nonce: 'aa11' },
      { kind: 'precmd', exitCode: 0, nonce: 'bb22' },
    ])
    expect([...out1]).toEqual([])
    expect(new TextDecoder().decode(out2)).toBe('$ ')
    expect(h.violations).toEqual([])
  })

  test('frames fragmented across chunk boundaries are reassembled', () => {
    const h = harness()
    const frame = frameFor('cwd', { w: '/repo' }, 'cc33')
    const mid = 7
    h.observer.feed(frame.slice(0, mid))
    h.observer.feed(frame.slice(mid, frame.length - 1))
    expect(h.observations).toEqual([])
    const tail = h.observer.feed(frame.slice(frame.length - 1))
    expect(h.observations).toEqual([{ kind: 'cwd', cwd: '/repo', nonce: 'cc33' }])
    expect([...tail]).toEqual([])
  })

  test('ST (ESC \\) terminators are accepted alongside BEL', () => {
    const observations: ShellObservation[] = []
    const observer = createShellIntegrationObserver({
      terminalId,
      generation,
      hookKey,
      onObservation: (observation) => observations.push(observation),
    })
    const text = payload('precmd', { e: 2 }, 'dd44')
    const payloadB64 = Buffer.from(text, 'utf8').toString('base64url')
    const mac = createHmac('sha256', hookKey)
      .update(
        hookMacMessage({
          terminalId,
          generation,
          kind: 'precmd',
          nonce: 'dd44',
          payloadSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        }),
        'utf8'
      )
      .digest('base64url')
    const frame = new TextEncoder().encode(`\u001b]133;adea;${payloadB64};${mac}\u001b\\`)
    observer.feed(frame)
    expect(observations).toEqual([{ kind: 'precmd', exitCode: 2, nonce: 'dd44' }])
  })

  test('a forged or foreign-key frame is an unauthenticated violation and is stripped', () => {
    const foreignKey = new Uint8Array(32).fill(9)
    const h = harness({ hookKey: foreignKey })
    const frame = frameFor('precmd', { e: 0 }, 'ee55', hookKey) // mac under the wrong key
    const out = h.observer.feed(concat(new TextEncoder().encode('x'), frame))
    expect(h.observations).toEqual([])
    expect(h.violations.map((violation) => violation.kind)).toEqual(['unauthenticated_frame'])
    expect(new TextDecoder().decode(out)).toBe('x')
  })

  test('frames bound to another terminal or generation do not verify', () => {
    const h = harness()
    const otherTerminal = frameFor(
      'precmd',
      { e: 0 },
      'ff66',
      hookKey,
      generation,
      '00000000-0000-4000-8000-0000000000e5'
    )
    const otherGeneration = frameFor('precmd', { e: 0 }, 'ff77', hookKey, generation + 1)
    h.observer.feed(otherTerminal)
    h.observer.feed(otherGeneration)
    expect(h.observations).toEqual([])
    expect(h.violations.map((violation) => violation.kind)).toEqual([
      'unauthenticated_frame',
      'unauthenticated_frame',
    ])
  })

  test('replayed nonces are rejected even with a valid mac', () => {
    const h = harness()
    h.observer.feed(frameFor('precmd', { e: 0 }, 'aa11'))
    h.observer.feed(frameFor('precmd', { e: 0 }, 'aa11'))
    expect(h.observations).toHaveLength(1)
    expect(h.violations.map((violation) => violation.kind)).toEqual(['replayed_nonce'])
  })

  test('hook frame rate is bounded per second', () => {
    const h = harness()
    for (let index = 0; index < 5; index += 1) {
      h.observer.feed(frameFor('precmd', { e: 0 }, `nonce-${index}`))
    }
    expect(h.observations).toHaveLength(3) // maxFramesPerSecond in the harness
    expect(h.violations.map((violation) => violation.kind)).toContain('rate_limited')
  })

  test('OSC 52 clipboard requests are denied, stripped, and counted', () => {
    const h = harness()
    const attack = new TextEncoder().encode('\u001b]52;c;aGVsbG8=\u0007')
    const out = h.observer.feed(concat(new TextEncoder().encode('safe'), attack))
    expect(h.violations.map((violation) => violation.kind)).toEqual(['clipboard_denied'])
    expect(new TextDecoder().decode(out)).toBe('safe')
  })

  test('plain OSC 133 markers and titles pass through byte-exact and never create observations', () => {
    const h = harness()
    const plain = new TextEncoder().encode('\u001b]133;C\u0007\u001b]0;my title\u0007')
    const out = h.observer.feed(plain)
    expect(h.observations).toEqual([])
    expect(new TextDecoder().decode(out)).toBe('\u001b]133;C\u0007\u001b]0;my title\u0007')
  })

  test('oversize OSC payloads are dropped, not truncated', () => {
    const h = harness()
    const oversize = new TextEncoder().encode(`\u001b]0;${'x'.repeat(3000)}\u0007`)
    const out = h.observer.feed(oversize)
    expect(h.violations.map((violation) => violation.kind)).toEqual(['oversize_frame'])
    expect(out.byteLength).toBe(0)
  })
})

describe('per-worktree history', () => {
  test('history files live at hashed relative IDs and deletion re-proves containment', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-hist-'))
    try {
      const worktreeId = '00000000-0000-4000-8000-0000000000f6'
      const zsh = resolveWorktreeHistoryFile(root, worktreeId, 'zsh')
      expect(zsh).toContain('history/')
      expect(zsh!.startsWith(root)).toBe(true)
      expect(resolveWorktreeHistoryFile(root, worktreeId, 'fish')).toBeNull()
      writeFileSync(zsh!, new TextEncoder().encode('cmd\n'), { mode: 0o600 })
      const deleted = deleteWorktreeHistory(root, worktreeId)
      expect(deleted).toEqual({ ok: true, deleted: 1 })
      expect(deleteWorktreeHistory(root, worktreeId)).toMatchObject({
        ok: false,
        code: 'not_found',
      })
      expect(existsSync(zsh!)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('hostile worktree IDs are rejected before any path is derived', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-hist-evil-'))
    try {
      expect(deleteWorktreeHistory(root, '../../escape' as never)).toMatchObject({
        ok: false,
        code: 'path_escape',
      })
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
