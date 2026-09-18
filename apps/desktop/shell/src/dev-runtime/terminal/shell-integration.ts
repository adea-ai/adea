// Shell integration (issue #396): content-addressed wrapper files, a
// positive-allowlist spawn environment, and authenticated OSC 133/7 shell
// observations.
//
// Provenance: per-worktree history environment injection (check-before-set,
// inherited-variable stripping, fish session naming) and the positive
// startup-feature allowlist that the wrapper destroys before user config
// runs are adapted from orca `src/main/terminal-history.ts` and
// `src/main/shell-startup-features.ts`
// (revision 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7, MIT). The
// allow-never-deny spawn environment fence is adapted from buzz
// `desktop/src-tauri/crates/buzz-terminal/src/env_fence.rs`
// (revision eed74bde2f4797714335ac10c56c0b0244c1def4, Apache-2.0).
//
// Clean-room boundary: command blocks are implemented against the external
// OSC 133/7 protocols only. Warp's AGPL hook names, DCS identifiers, payload
// schemas, parser structure, fixtures, and UI strings are not used. The Adea
// observation frame (`ESC]133;adea;<payload>;<mac>BEL`) is an independent
// design whose authentication binds terminal, generation, kind, nonce, and
// payload digest (docs/specs/dev-runtime.md, "Shell integration and input").
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

import { TERMINAL_LIMITS } from './limits'

export const SHELL_WRAPPER_PROTOCOL_VERSION = 1

export type ShellKind = 'zsh' | 'bash' | 'fish' | 'unknown'

export type ShellFeature = 'markers' | 'cwd' | 'history'

export const SHELL_FEATURES: readonly ShellFeature[] = ['markers', 'cwd', 'history']

/** Env keys a terminal child may inherit from the host process (buzz fence). */
const INHERIT_ENV_ALLOWLIST = [
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'SHELL',
  'PATH',
] as const

/** Env keys Adea itself mints; the wrapper unsets these before user config. */
export const ADEA_TERMINAL_ENV_KEYS = [
  'ADEA_TERMINAL_ID',
  'ADEA_TERMINAL_GENERATION',
  'ADEA_TERMINAL_HOOK_KEY',
  'ADEA_SHELL_FEATURES',
  'ADEA_HISTFILE',
] as const

export function parseShellKind(shellPath: string): ShellKind {
  const name = basename(shellPath).toLowerCase()
  if (name.startsWith('zsh')) return 'zsh'
  if (name.startsWith('bash')) return 'bash'
  if (name.startsWith('fish')) return 'fish'
  return 'unknown'
}

/**
 * Pure selection of wrapper features from launch intent (orca's positive
 * allowlist): an inherited or hostile `ADEA_SHELL_FEATURES` value can only
 * mean fewer features, never more, because selection never reads it.
 */
export function selectShellFeatures(input: {
  shellKind: ShellKind
  wantsCommandMarkers: boolean
  reportsCwd: boolean
  wantsHistory: boolean
}): ShellFeature[] {
  const supported: Record<ShellFeature, boolean> = {
    markers: input.wantsCommandMarkers && input.shellKind !== 'unknown',
    cwd: input.reportsCwd && input.shellKind !== 'unknown',
    history: input.wantsHistory && input.shellKind !== 'unknown',
  }
  return SHELL_FEATURES.filter((feature) => supported[feature])
}

export type TerminalEnvInput = {
  terminalId: string
  generation: number
  hookKey: Uint8Array
  features: readonly ShellFeature[]
  /** Absolute history file for this worktree, when the shell uses one. */
  histFile?: string
  /** fish history session name, when fish is the shell. */
  fishHistorySession?: string
  /** Extra reviewed project additions, applied after the allowlist. */
  projectEnv?: Record<string, string>
}

/**
 * Builds the spawn environment from a positive allowlist (buzz fence): the
 * inherited environment is dropped wholesale, allowlisted keys are rebuilt,
 * and only Adea-minted and explicitly reviewed additions are layered on.
 * Unknown inherited keys — including future secret-shaped ones — never reach
 * the child.
 */
export function buildTerminalEnv(
  inherited: Record<string, string | undefined>,
  input: TerminalEnvInput
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of INHERIT_ENV_ALLOWLIST) {
    const value = inherited[key]
    if (typeof value === 'string') env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.ADEA_TERMINAL_ID = input.terminalId
  env.ADEA_TERMINAL_GENERATION = String(input.generation)
  env.ADEA_TERMINAL_HOOK_KEY = Buffer.from(input.hookKey).toString('base64url')
  env.ADEA_SHELL_FEATURES = input.features.join(',')
  if (input.histFile) env.ADEA_HISTFILE = input.histFile
  // zsh history via HISTFILE with a check-before-set guard; bash reads
  // HISTFILE natively. fish ignores HISTFILE and keys its history off
  // `fish_history` (orca history semantics).
  if (input.histFile && !env.HISTFILE) env.HISTFILE = input.histFile
  if (input.fishHistorySession) env.fish_history = input.fishHistorySession
  for (const [key, value] of Object.entries(input.projectEnv ?? {})) env[key] = value
  return env
}

export type WrapperDescriptor = {
  shellKind: ShellKind
  features: readonly ShellFeature[]
  /** Content address (sha256) of the wrapper text. */
  contentSha256: string
  content: string
}

/** Pure wrapper text for one shell kind + feature set. */
export function wrapperContent(shellKind: ShellKind, features: readonly ShellFeature[]): string {
  const enabled = (feature: ShellFeature): boolean => features.includes(feature)
  if (shellKind === 'zsh') {
    const lines: string[] = [
      `# Adea terminal shell integration v${SHELL_WRAPPER_PROTOCOL_VERSION}.`,
      `# Content-addressed and owner-only; safe to source from .zshrc.`,
      `__adea_unsetup() { unset -f __adea_unsetup __adea_emit __adea_hook __adea_preexec >/dev/null 2>&1 || true }`,
      `__adea_features="${features.join(',')}"`,
      `__adea_emit() {`,
      `  local kind="$1"; shift`,
      `  local payload nonce`,
      `  nonce="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \\n')"$`,
      `  nonce="\${nonce:-0000000000000000}"`,
      `  payload="{\\"v\\":1,\\"k\\":\\"$kind\\",\\"n\\":\\"$nonce\\"$([[ -n $1 ]] && printf ',%s' "$1")}"}`,
      `  printf '\\033]133;adea;%s;%s\\007' "$(printf %s "$payload" | base64 | tr -d '\\n')" "$(printf %s "$payload" | openssl dgst -sha256 -hmac "$ADEA_TERMINAL_HOOK_KEY" -binary | base64 | tr -d '\\n')"$`,
      `}`,
    ]
    if (enabled('markers')) {
      lines.push(
        `__adea_preexec() { __adea_hook preexec "{\\"c\\":\\"$(printf %s "$1" | head -c 512 | base64 | tr -d '\\n')\\"}" ; }`,
        `typeset -ga preexec_functions`,
        `preexec_functions+=(__adea_preexec)`,
        `typeset -ga precmd_functions`,
        `precmd_functions+=('__adea_hook precmd "{\\"e\\":$?}"')`
      )
    }
    if (enabled('cwd')) {
      lines.push(`precmd_functions+=('__adea_hook cwd "{\\"w\\":\\"$PWD\\"}"')`)
    }
    if (enabled('history')) {
      lines.push(
        `# Per-worktree history: the host injected ADEA_HISTFILE; system zshrc`,
        `# clobbers HISTFILE unconditionally, so restore it after user config.`,
        `if [[ -n "$ADEA_HISTFILE" ]]; then HISTFILE="$ADEA_HISTFILE"; fi`
      )
    }
    lines.push(`__adea_unsetup`, ``)
    return lines.join('\n')
  }
  if (shellKind === 'bash') {
    const lines: string[] = [
      `# Adea terminal shell integration v${SHELL_WRAPPER_PROTOCOL_VERSION}.`,
      `# Content-addressed and owner-only; safe to source from .bashrc.`,
      `__adea_unsetup() { unset -f __adea_unsetup __adea_emit __adea_hook __adea_preexec >/dev/null 2>&1 || true }`,
      `__adea_emit() {`,
      `  local kind="$1"; shift`,
      `  local payload nonce`,
      `  nonce="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \\n')"$`,
      `  nonce="\${nonce:-0000000000000000}"`,
      `  payload="{\\"v\\":1,\\"k\\":\\"$kind\\",\\"n\\":\\"$nonce\\"$([[ -n $1 ]] && printf ',%s' "$1")}"}`,
      `  printf '\\033]133;adea;%s;%s\\007' "$(printf %s "$payload" | base64 | tr -d '\\n')" "$(printf %s "$payload" | openssl dgst -sha256 -hmac "$ADEA_TERMINAL_HOOK_KEY" -binary | base64 | tr -d '\\n')"$`,
      `}`,
    ]
    if (enabled('markers')) {
      lines.push(
        `__adea_preexec() { case "$1" in *'__adea_'*) return;; esac; __adea_hook preexec "{\\"c\\":\\"$(printf %s "$1" | head -c 512 | base64 | tr -d '\\n')\\"}"; }`,
        `trap '__adea_preexec "$BASH_COMMAND"' DEBUG`,
        `__adea_precmd() { __adea_hook precmd "{\\"e\\":$?}"; }`,
        `PROMPT_COMMAND="__adea_precmd$\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"`
      )
    }
    if (enabled('cwd')) {
      lines.push(`__adea_precmd() { __adea_hook cwd "{\\"w\\":\\"$PWD\\"}"; }`)
    }
    if (enabled('history')) {
      lines.push(`if [[ -n "$ADEA_HISTFILE" ]]; then HISTFILE="$ADEA_HISTFILE"; fi`)
    }
    lines.push(`__adea_unsetup`, ``)
    return lines.join('\n')
  }
  if (shellKind === 'fish') {
    // fish keeps history in its own data dir keyed by session; the wrapper
    // only reports markers/cwd events (history itself rides fish_history).
    const lines: string[] = [
      `# Adea terminal shell integration v${SHELL_WRAPPER_PROTOCOL_VERSION} (fish).`,
      `function __adea_emit`,
      `  set -l kind $argv[1]`,
      `  set -l nonce (od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \\n')`,
      `  set -l payload (printf '{"v":1,"k":"%s","n":"%s"}' "$kind" "$nonce")`,
      `  printf '\\033]133;adea;%s;%s\\007' (printf %s "$payload" | base64 | tr -d '\\n') (printf %s "$payload" | openssl dgst -sha256 -hmac "$ADEA_TERMINAL_HOOK_KEY" -binary | base64 | tr -d '\\n')`,
      `end`,
    ]
    if (enabled('markers')) {
      lines.push(
        `function __adea_preexec --on-event fish_preexec`,
        `  __adea_emit preexec (printf '{"c":"%s"}' (printf %s "$argv" | head -c 512 | base64 | tr -d '\\n'))`,
        `end`,
        `function __adea_precmd --on-event fish_prompt`,
        `  __adea_emit precmd '{"e":0}'`,
        `end`
      )
    }
    if (enabled('cwd')) {
      lines.push(
        `function __adea_cwd --on-variable PWD; __adea_emit cwd (printf '{"w":"%s"}' "$PWD"); end`
      )
    }
    lines.push(`set -e ADEA_TERMINAL_HOOK_KEY`, `set -e ADEA_SHELL_FEATURES`, ``)
    return lines.join('\n')
  }
  // Unknown shells are unwrapped by design: no silent integration.
  return ''
}

export const MAC_SEPARATOR = '\u001f'

/** The canonical MAC input shared by wrapper and host. */
export function hookMacMessage(input: {
  terminalId: string
  generation: number
  kind: string
  nonce: string
  payloadSha256: string
}): string {
  return [
    input.terminalId,
    String(input.generation),
    input.kind,
    input.nonce,
    input.payloadSha256,
  ].join(MAC_SEPARATOR)
}

export function hookMac(hookKey: Uint8Array, message: string): Buffer {
  return createHmac('sha256', hookKey).update(message, 'utf8').digest()
}

export type ShellObservation =
  | Readonly<{ kind: 'preexec'; command: string; nonce: string }>
  | Readonly<{ kind: 'precmd'; exitCode: number; nonce: string }>
  | Readonly<{ kind: 'cwd'; cwd: string; nonce: string }>

export type ShellIntegrationObserverOptions = {
  terminalId: string
  generation: number
  hookKey: Uint8Array
  now?: () => number
  /** Test override; production uses the normative 1,000 frames/second. */
  maxFramesPerSecond?: number
  onObservation?: (observation: ShellObservation) => void
  onViolation?: (violation: {
    kind:
      | 'clipboard_denied'
      | 'unauthenticated_frame'
      | 'oversize_frame'
      | 'replayed_nonce'
      | 'rate_limited'
    detail: string
  }) => void
}

const OSC_ADEA_PREFIX = '133;adea;'
const OSC_CLIPBOARD_PREFIX = '52;'

/**
 * Byte-level output sanitizer and observation parser. Runs on every PTY byte
 * before ring storage: authenticated `adea` hook frames are verified, turned
 * into observations, and stripped from display bytes; OSC 52 clipboard
 * requests are denied (stripped and counted); other OSC sequences are
 * bounded at the spec's 2 KiB payload limit and dropped when oversize.
 * Everything else passes through byte-exact.
 */
export function createShellIntegrationObserver(options: ShellIntegrationObserverOptions) {
  const now = options.now ?? Date.now
  const decoder = new TextDecoder('utf-8', { fatal: false })
  // Nonce replay window per terminal (recent nonces only; bounded).
  const seenNonces = new Set<string>()
  const nonceOrder: string[] = []
  const MAX_TRACKED_NONCES = 4096
  let frameTimestamps: number[] = []
  let buffer: number[] = []
  let inOsc = false
  let oscBytes: number[] = []
  let sawEscInsideOsc = false
  let oscBytesLimitExceeded = false

  function trackNonce(nonce: string): boolean {
    if (seenNonces.has(nonce)) return false
    seenNonces.add(nonce)
    nonceOrder.push(nonce)
    if (nonceOrder.length > MAX_TRACKED_NONCES) {
      const evicted = nonceOrder.shift()
      if (evicted) seenNonces.delete(evicted)
    }
    return true
  }

  const maxFramesPerSecond = options.maxFramesPerSecond ?? TERMINAL_LIMITS.maxHookFramesPerSecond

  function rateLimited(): boolean {
    const at = now()
    frameTimestamps = frameTimestamps.filter((stamp) => at - stamp < 1_000)
    if (frameTimestamps.length >= maxFramesPerSecond) return true
    frameTimestamps.push(at)
    return false
  }

  function verifyAdeaFrame(oscPayload: string): ShellObservation | null {
    // `adea;<payload-b64url>;<mac-b64url>`
    const rest = oscPayload.slice(OSC_ADEA_PREFIX.length)
    const separator = rest.lastIndexOf(';')
    if (separator <= 0 || separator === rest.length - 1) {
      options.onViolation?.({ kind: 'unauthenticated_frame', detail: 'malformed adea frame' })
      return null
    }
    let payloadBytes: Uint8Array
    let macBytes: Uint8Array
    try {
      payloadBytes = Uint8Array.from(Buffer.from(rest.slice(0, separator), 'base64url'))
      macBytes = Uint8Array.from(Buffer.from(rest.slice(separator + 1), 'base64url'))
    } catch {
      options.onViolation?.({ kind: 'unauthenticated_frame', detail: 'undecodable frame' })
      return null
    }
    let parsed: { v?: unknown; k?: unknown; n?: unknown; c?: unknown; e?: unknown; w?: unknown }
    try {
      parsed = JSON.parse(decoder.decode(payloadBytes))
    } catch {
      options.onViolation?.({ kind: 'unauthenticated_frame', detail: 'payload is not JSON' })
      return null
    }
    if (
      parsed.v !== SHELL_WRAPPER_PROTOCOL_VERSION ||
      typeof parsed.k !== 'string' ||
      typeof parsed.n !== 'string'
    ) {
      options.onViolation?.({
        kind: 'unauthenticated_frame',
        detail: 'unsupported payload version',
      })
      return null
    }
    const payloadSha256 = createHash('sha256').update(payloadBytes).digest('hex')
    const expectedMac = createHmac('sha256', options.hookKey)
      .update(
        hookMacMessage({
          terminalId: options.terminalId,
          generation: options.generation,
          kind: parsed.k,
          nonce: parsed.n,
          payloadSha256,
        }),
        'utf8'
      )
      .digest()
    const macMatches =
      expectedMac.length === macBytes.length && timingSafeEqual(expectedMac, Buffer.from(macBytes))
    if (!macMatches) {
      options.onViolation?.({ kind: 'unauthenticated_frame', detail: 'mac did not verify' })
      return null
    }
    if (!trackNonce(parsed.n)) {
      options.onViolation?.({
        kind: 'replayed_nonce',
        detail: `nonce ${parsed.n} was already consumed`,
      })
      return null
    }
    if (parsed.k === 'preexec' && typeof parsed.c === 'string') {
      return { kind: 'preexec', command: parsed.c, nonce: parsed.n }
    }
    if (parsed.k === 'precmd' && typeof parsed.e === 'number') {
      return { kind: 'precmd', exitCode: parsed.e, nonce: parsed.n }
    }
    if (parsed.k === 'cwd' && typeof parsed.w === 'string') {
      return { kind: 'cwd', cwd: parsed.w, nonce: parsed.n }
    }
    options.onViolation?.({
      kind: 'unauthenticated_frame',
      detail: `unknown kind ${String(parsed.k)}`,
    })
    return null
  }

  function finishOsc(): Uint8Array | null {
    inOsc = false
    sawEscInsideOsc = false
    const text = decoder.decode(Uint8Array.from(oscBytes))
    oscBytes = []
    if (text.startsWith(OSC_ADEA_PREFIX)) {
      if (oscBytesLimitExceeded) {
        options.onViolation?.({ kind: 'oversize_frame', detail: 'hook frame exceeded 8 KiB' })
        oscBytesLimitExceeded = false
        return null
      }
      oscBytesLimitExceeded = false
      if (rateLimited()) {
        options.onViolation?.({ kind: 'rate_limited', detail: 'hook frame rate exceeded' })
        return null
      }
      const observation = verifyAdeaFrame(text)
      if (observation) options.onObservation?.(observation)
      return null // protocol frames never reach the renderer
    }
    if (text.startsWith(OSC_CLIPBOARD_PREFIX)) {
      options.onViolation?.({
        kind: 'clipboard_denied',
        detail: 'OSC 52 clipboard write was denied',
      })
      return null // denied by default; no user approval surface in M12
    }
    if (text.length > TERMINAL_LIMITS.oscPayloadMaxBytes) {
      options.onViolation?.({ kind: 'oversize_frame', detail: 'OSC payload exceeded 2 KiB' })
      return null
    }
    // Benign OSC (titles, links, plain 133 markers): bounded, passes through.
    const bytes = new TextEncoder().encode(`\u001b]${text}\u0007`)
    return bytes
  }

  function feed(data: Uint8Array): Uint8Array {
    const out: Uint8Array[] = []
    const push = (bytes: Uint8Array | null): void => {
      if (bytes && bytes.byteLength > 0) out.push(bytes)
    }
    for (let index = 0; index < data.byteLength; index += 1) {
      const byte = data[index]!
      if (!inOsc) {
        if (byte === 0x1b) {
          buffer = [byte]
        } else if (buffer.length === 1 && byte === 0x5d) {
          // ESC ] — OSC start.
          buffer = []
          inOsc = true
          oscBytes = []
          oscBytesLimitExceeded = false
        } else if (buffer.length === 1) {
          push(Uint8Array.from(buffer))
          push(Uint8Array.from([byte]))
          buffer = []
        } else {
          push(Uint8Array.from([byte]))
        }
        continue
      }
      // Inside an OSC sequence: BEL terminates; ESC \ (ST) terminates.
      if (byte === 0x07) {
        push(finishOsc())
        continue
      }
      if (byte === 0x1b) {
        sawEscInsideOsc = true
        continue
      }
      if (sawEscInsideOsc && byte === 0x5c) {
        push(finishOsc())
        continue
      }
      if (sawEscInsideOsc) {
        oscBytes.push(0x1b)
        sawEscInsideOsc = false
      }
      oscBytes.push(byte)
      if (oscBytes.length > TERMINAL_LIMITS.hookFrameMaxBytes) {
        oscBytesLimitExceeded = true
        oscBytes = []
        inOsc = false
        sawEscInsideOsc = false
        options.onViolation?.({ kind: 'oversize_frame', detail: 'frame exceeded the hook bound' })
      }
    }
    const total = out.reduce((sum, part) => sum + part.byteLength, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const part of out) {
      merged.set(part, offset)
      offset += part.byteLength
    }
    return merged
  }

  return { feed, trackedNonceCount: () => seenNonces.size }
}

export type ShellIntegrationObserver = ReturnType<typeof createShellIntegrationObserver>

export type WrapperInstall = Readonly<{
  path: string
  contentSha256: string
  reused: boolean
}>

/**
 * Installs a content-addressed wrapper under the owner-only runtime root.
 * The file name is the sha256 of its content, so identical feature sets
 * reuse the same file and a mutated file can never be mistaken for the
 * addressed one.
 */
export function installWrapper(options: {
  runtimeRoot: string
  shellKind: ShellKind
  features: readonly ShellFeature[]
}): WrapperInstall {
  const content = wrapperContent(options.shellKind, options.features)
  if (content === '') {
    throw new TypeError(`no wrapper is generated for shell kind ${options.shellKind}`)
  }
  const contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex')
  const wrappersDir = join(options.runtimeRoot, 'wrappers')
  mkdirSync(wrappersDir, { recursive: true, mode: 0o700 })
  const path = join(
    wrappersDir,
    `${options.shellKind}-${contentSha256.slice(0, 32)}.adea.${options.shellKind}`
  )
  const reused = existsSync(path)
  if (!reused) writeFileSync(path, content, { mode: 0o600 })
  return { path, contentSha256, reused }
}

export function newHookKey(): Uint8Array {
  return randomBytes(32)
}

// ── Per-worktree shell history ────────────────────────────────────────────
//
// History lives at relative, content-derived identifiers beneath the
// owner-only runtime root. A persisted absolute path is a label, never
// deletion authority: deletion resolves and re-proves containment and file
// identity immediately before the unlink (Dev Runtime spec).

export function worktreeHistoryDir(runtimeRoot: string, worktreeId: string): string {
  // The worktree ID is an opaque UUID; the hash keeps directory names
  // non-guessable, non-enumerable relative identifiers.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(worktreeId)
  ) {
    throw new TypeError('worktree id is not an opaque UUID')
  }
  const hash = createHash('sha256').update(worktreeId, 'utf8').digest('hex').slice(0, 32)
  return join(runtimeRoot, 'history', hash)
}

export function resolveWorktreeHistoryFile(
  runtimeRoot: string,
  worktreeId: string,
  shellKind: ShellKind
): string | null {
  const filename =
    shellKind === 'zsh' ? 'zsh_history' : shellKind === 'bash' ? 'bash_history' : null
  if (!filename) return null // fish keys history off its own session name
  const dir = worktreeHistoryDir(runtimeRoot, worktreeId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, filename)
}

export function deleteWorktreeHistory(
  runtimeRoot: string,
  worktreeId: string
):
  | { ok: true; deleted: number }
  | { ok: false; code: 'path_escape' | 'not_found'; message: string } {
  let dir: string
  try {
    dir = worktreeHistoryDir(runtimeRoot, worktreeId)
  } catch {
    return { ok: false, code: 'path_escape', message: 'worktree id was rejected' }
  }
  if (!existsSync(dir)) return { ok: false, code: 'not_found', message: 'no history for worktree' }
  // Containment re-proof immediately before deletion: the resolved directory
  // must still live beneath the resolved runtime root.
  const resolvedDir = realpathSync(dir)
  const resolvedRoot = realpathSync(runtimeRoot)
  if (!resolvedDir.startsWith(resolvedRoot + '/')) {
    return { ok: false, code: 'path_escape', message: 'history directory escaped the runtime root' }
  }
  let deleted = 0
  for (const entry of readdirSync(resolvedDir)) {
    const target = join(resolvedDir, entry)
    if (!realpathSync(target).startsWith(resolvedDir + '/') && realpathSync(target) !== target) {
      return { ok: false, code: 'path_escape', message: 'history entry escaped its directory' }
    }
    if (statSync(target).isFile()) {
      unlinkSync(target)
      deleted += 1
    }
  }
  rmdirSync(resolvedDir)
  return { ok: true, deleted }
}
