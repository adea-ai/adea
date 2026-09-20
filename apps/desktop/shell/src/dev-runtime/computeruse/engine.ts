// Computer-use engine: the seam between the dev.computeruse.* providers and
// the host's fixed-argv tooling. Keyboard synthesis goes through
// `/usr/bin/osascript` System Events (`keystroke` / `key code`), which macOS
// gates behind the Accessibility TCC service the #471 probe proves; every
// argv is a fixed template whose only free elements are an escaped
// AppleScript string literal or an allowlisted integer/token — caller text
// can never reach a second argv slot, let alone a shell. Capture and AX-tree
// reading refuse closed with the exact missing piece: this lane has no
// native screen-recording helper and no authorized AX bridge (spec:
// "Computer use lanes"; donor preflight rule: Orca
// ScreenCapturePermissionPreflightSafety, MIT). Tests inject a scripted
// runner — CI never performs real input.
import type { HostCommandRunner } from '../../desktop-permissions'
import { AX_TREE_MISSING_PIECE, CAPTURE_MISSING_PIECE } from './capability'

/** Input text shares the stream protocol's 4 KiB text cap (spec). */
export const INPUT_TEXT_MAX_CHARS = 4096
/** Deadline for one bounded input delivery. */
export const INPUT_TIMEOUT_MS = 5_000

export type ComputerUseEventCode =
  | 'permission_denied'
  | 'capability_unavailable'
  | 'invalid_state'
  | 'timeout'
  | 'spawn_failed'

export class ComputerUseEngineError extends Error {
  readonly code: ComputerUseEventCode
  readonly retryable: boolean
  readonly remediation?: { action: string; parameters?: Record<string, string> }
  constructor(
    code: ComputerUseEventCode,
    message: string,
    options?: {
      retryable?: boolean
      remediation?: { action: string; parameters?: Record<string, string> }
    }
  ) {
    super(message)
    this.name = 'ComputerUseEngineError'
    this.code = code
    this.retryable = options?.retryable ?? false
    this.remediation = options?.remediation
  }
}

export type ComputerUseInputEvent =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{
      kind: 'key'
      /** A System Events key code; integer 0..127 only. */
      code: number
      modifiers?: readonly ('command' | 'option' | 'control' | 'shift')[]
    }>

const KEY_MODIFIERS = ['command', 'option', 'control', 'shift'] as const

/** Control characters that AppleScript string literals cannot carry. */
function containsForbiddenControl(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true
    if (code === 0x7f) return true
  }
  return false
}

/**
 * Strict decoder for one input event off the wire (canonical-CBOR payload of
 * a `desktop-frames-v1` write frame). Unknown kinds/keys reject; free text is
 * capped and stripped of control characters that could smuggle AppleScript.
 */
export function decodeComputerUseInputEvent(value: unknown): ComputerUseInputEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ComputerUseEngineError('invalid_state', 'input event must be an object')
  const item = value as Record<string, unknown>
  if (item.kind === 'text') {
    for (const key of Object.keys(item))
      if (key !== 'kind' && key !== 'text')
        throw new ComputerUseEngineError('invalid_state', `unknown input field ${key}`)
    if (typeof item.text !== 'string' || item.text.length === 0)
      throw new ComputerUseEngineError('invalid_state', 'text input requires non-empty text')
    if (item.text.length > INPUT_TEXT_MAX_CHARS)
      throw new ComputerUseEngineError('invalid_state', 'text input exceeds 4096 characters')
    // Control characters never synthesize: they are either lost by the OS or
    // an attempt to smuggle keystroke escapes. Tab and line breaks are
    // escaped into AppleScript escapes by the argv builder instead.
    if (containsForbiddenControl(item.text))
      throw new ComputerUseEngineError('invalid_state', 'text input contains control characters')
    return { kind: 'text', text: item.text }
  }
  if (item.kind === 'key') {
    for (const key of Object.keys(item))
      if (key !== 'kind' && key !== 'code' && key !== 'modifiers')
        throw new ComputerUseEngineError('invalid_state', `unknown input field ${key}`)
    if (
      typeof item.code !== 'number' ||
      !Number.isInteger(item.code) ||
      item.code < 0 ||
      item.code > 127
    )
      throw new ComputerUseEngineError('invalid_state', 'key code must be an integer 0..127')
    if (item.modifiers !== undefined) {
      if (!Array.isArray(item.modifiers) || item.modifiers.length > KEY_MODIFIERS.length)
        throw new ComputerUseEngineError('invalid_state', 'modifiers must be an allowlisted array')
      for (const modifier of item.modifiers)
        if (!(KEY_MODIFIERS as readonly string[]).includes(modifier as string))
          throw new ComputerUseEngineError(
            'invalid_state',
            `unknown key modifier ${String(modifier)}`
          )
    }
    return {
      kind: 'key',
      code: item.code,
      ...(Array.isArray(item.modifiers)
        ? { modifiers: item.modifiers as ('command' | 'option' | 'control' | 'shift')[] }
        : {}),
    }
  }
  throw new ComputerUseEngineError('invalid_state', 'unsupported input event kind')
}

/**
 * Escapes free text into an AppleScript string literal. Backslashes and
 * double quotes are escaped first, then tab/line breaks become escapes — a
 * payload like `" & do shell script "x` stays an inert literal, so the
 * AppleScript string can never be broken out of.
 */
export function escapeAppleScriptString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

/** The fixed argv template for typed text (`keystroke`). */
export function keystrokeTextArgv(text: string): readonly string[] {
  return [
    '/usr/bin/osascript',
    '-e',
    `tell application "System Events" to keystroke "${escapeAppleScriptString(text)}"`,
  ]
}

/** The fixed argv template for a key-code press (`key code`), modifiers only as allowlisted tokens. */
export function keyCodeArgv(code: number, modifiers?: readonly string[]): readonly string[] {
  let script = `tell application "System Events" to key code ${code}`
  if (modifiers && modifiers.length > 0) {
    const tokens = modifiers
      .map((modifier) => `${modifier} down`)
      .toSorted()
      .join(', ')
    script += ` using {${tokens}}`
  }
  return ['/usr/bin/osascript', '-e', script]
}

const ASSISTIVE_ACCESS_DENIED = /assistive access/i

export type ComputerUseEngine = Readonly<{
  /**
   * Delivers one validated input event through the host input tool. The
   * provider has already gated authority; the engine only talks to the OS.
   */
  injectInput(event: ComputerUseInputEvent): Promise<void>
  /**
   * Captures one desktop frame. Typed-unavailable in this lane until the
   * deferred native screen-recording helper lands — never a placeholder.
   */
  capture(): Promise<never>
  /** Reads the accessibility tree; typed-unavailable in this lane. */
  readAccessibilityTree(): Promise<never>
}>

export function createHostComputerUseEngine(runner: HostCommandRunner): ComputerUseEngine {
  async function runBounded(argv: readonly string[]) {
    const outcome = await runner(argv)
    if (outcome.exitCode === 0) return
    if (outcome.spawnFailed)
      throw new ComputerUseEngineError(
        'capability_unavailable',
        'the host input tool is unavailable',
        { retryable: true }
      )
    if (outcome.timedOut)
      throw new ComputerUseEngineError('timeout', 'the host input tool did not answer in time', {
        retryable: true,
      })
    if (ASSISTIVE_ACCESS_DENIED.test(outcome.stderr + outcome.stdout))
      throw new ComputerUseEngineError(
        'permission_denied',
        'the accessibility grant refused the input tool; repair it in System Settings',
        { remediation: { action: 'open_settings', parameters: { permissionId: 'accessibility' } } }
      )
    throw new ComputerUseEngineError('invalid_state', 'the host input tool refused the event')
  }

  return {
    async injectInput(event) {
      if (event.kind === 'text') return runBounded(keystrokeTextArgv(event.text))
      return runBounded(keyCodeArgv(event.code, event.modifiers))
    },

    async capture() {
      throw new ComputerUseEngineError('capability_unavailable', CAPTURE_MISSING_PIECE)
    },

    async readAccessibilityTree() {
      throw new ComputerUseEngineError('capability_unavailable', AX_TREE_MISSING_PIECE)
    },
  }
}
