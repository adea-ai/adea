// Machine-wide process inventory (spec "Machine-wide inventory and foreign
// stop"). Agents leave servers, debuggers, and automation browsers running
// outside Adea's launch records, so under the default `machine` coverage the
// resources sheet lists them as foreign rows.
//
// Every observation is bounded and read-only: one `ps` listing per pull, one
// loopback listener scan at most every visible sample interval (never faster
// than 2 s), and one working-directory lookup for rows not seen before, each
// through the capped command runner (5 s, 1 MiB). A failed or truncated
// observation leaves its fields absent; it is never reported as empty truth.
//
// Attribution and protection are display and policy inputs only. Nothing in
// this module grants authority to signal a process: the foreign stop path
// re-proves identity, owner, and protection immediately before every signal.
import { createHash } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { cpus, freemem, homedir, totalmem } from 'node:os'
import { basename } from 'node:path'

import type {
  ForeignProcessAttribution,
  ForeignProcessProtection,
  ForeignProcessRecord,
  MachineResourceSummary,
  ResourcePreferences,
} from '../../../../../../packages/types/src/dev-runtime'
import { parseLsofOutput } from '../browser/port-inventory'
import { completed, type CappedCommandRunner } from './capped-command'
import { parseCpuSeconds } from './sample-processes'

/** Largest remaining Adea-user processes listed besides listeners and automation apps. */
export const MAX_LARGEST_FOREIGN_ROWS = 64
/** Hard cap on emitted foreign rows per observation. */
export const MAX_FOREIGN_ROWS = 256
/** Parent-chain hops walked for harness attribution. */
export const MAX_ATTRIBUTION_HOPS = 16
/** Foreign history window and the number of points a row carries. */
export const FOREIGN_HISTORY_WINDOW_MS = 10 * 60_000
export const FOREIGN_HISTORY_POINTS = 30
/** The listener scan never runs faster than this. */
export const MIN_LISTENER_SCAN_INTERVAL_MS = 2_000
const COMMAND_PREVIEW_MAX = 160
const LABEL_MAX = 128

/**
 * Fixed executable matchers shipped with Adea. The `recognizedHarnesses`
 * preference only selects which of these are on; a user can never supply a
 * pattern of their own.
 */
export const HARNESS_EXECUTABLES: Readonly<Record<string, readonly string[]>> = {
  'Claude Code': ['claude'],
  Codex: ['codex'],
  OpenCode: ['opencode'],
  Hermes: ['hermes'],
  Cursor: ['cursor-agent'],
  Aider: ['aider'],
  'Gemini CLI': ['gemini'],
}

/** Executable path prefixes that belong to the operating system. */
const SYSTEM_PATH_PREFIXES = [
  '/System/',
  '/usr/libexec/',
  '/usr/sbin/',
  '/sbin/',
  '/Library/Apple/',
]
const SYSTEM_NAMES = new Set(['kernel_task', 'launchd', 'WindowServer', 'loginwindow'])
/** Interactive shells: a process below one inside the Adea tree was started
 * by the user in an Adea terminal, not by Adea itself. */
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'nu', 'pwsh', 'dash', 'ksh', 'tcsh'])

/** The registered worktree whose root contains `cwd` (longest root wins). */
export function worktreeForCwd(
  cwd: string | undefined,
  roots: readonly Readonly<{ id: string; root: string }>[]
): string | undefined {
  if (!cwd) return undefined
  let best: { id: string; length: number } | undefined
  for (const { id, root } of roots) {
    const prefix = root.endsWith('/') ? root : `${root}/`
    if (cwd !== root && !cwd.startsWith(prefix)) continue
    if (!best || root.length > best.length) best = { id, length: root.length }
  }
  return best?.id
}

export type ProcessListingRow = Readonly<{
  pid: number
  ppid: number
  uid: number
  /** Resident set size in bytes. */
  residentBytes: number
  cpuSeconds?: number
  startIdentity: string
  executableIdentity: string
}>

const PROCESS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/

/**
 * Parses `ps -axww -o pid=,ppid=,uid=,rss=,time=,lstart=,comm=`. `lstart` is
 * always five whitespace-separated tokens (`Tue Oct  6 09:14:03 2026`) and
 * `comm` is the remainder of the line, so paths with spaces survive. A
 * malformed line is skipped, never guessed.
 */
export function parseProcessListing(stdout: string): ProcessListingRow[] {
  const rows: ProcessListingRow[] = []
  for (const line of stdout.split('\n')) {
    const match = PROCESS_LINE.exec(line)
    if (!match) continue
    const [, pidText, ppidText, uidText, rssText, timeText, start, comm] = match
    const pid = Number(pidText)
    const ppid = Number(ppidText)
    const uid = Number(uidText)
    const rssKiB = Number(rssText)
    if (![pid, ppid, uid, rssKiB].every((value) => Number.isSafeInteger(value) && value >= 0))
      continue
    if (pid === 0) continue
    const executableIdentity = (comm as string).trim()
    if (executableIdentity.length === 0) continue
    const cpuSeconds = parseCpuSeconds(timeText as string)
    rows.push({
      pid,
      ppid,
      uid,
      residentBytes: rssKiB * 1024,
      ...(cpuSeconds !== undefined ? { cpuSeconds } : {}),
      startIdentity: normalizeStartIdentity(start as string),
      executableIdentity,
    })
  }
  return rows
}

/** `lstart` pads single-digit days with a space; identities compare on the
 * whitespace-collapsed form so every observer agrees. */
export function normalizeStartIdentity(text: string): string {
  return text.trim().split(/\s+/).join(' ')
}

/** Parses `ps -axww -o pid=,args=` into a PID → full command line map. */
export function parseArgsListing(stdout: string): Map<number, string> {
  const args = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    args.set(Number(match[1]), (match[2] as string).trim())
  }
  return args
}

/** Parses `lsof -a -d cwd -nP -F pn -p <pids>` into a PID → cwd map. */
export function parseCwdListing(stdout: string): Map<number, string> {
  const cwd = new Map<number, string>()
  let pid: number | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number(line.slice(1))
      pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
    } else if (line.startsWith('n') && pid !== undefined && !cwd.has(pid)) {
      cwd.set(pid, line.slice(1))
    }
  }
  return cwd
}

function bounded(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function homeRelative(text: string, home: string | undefined): string {
  if (!home || home === '/') return text
  return text.split(home).join('~')
}

const SECRET_FLAG =
  /^--?[\w.-]*(token|password|passwd|secret|api[-_]?key|apikey|auth|credential|key)s?$/i
const SECRET_ASSIGNMENT =
  /^([\w.-]*(token|password|passwd|secret|api[-_]?key|apikey|auth|credential|key)s?)=.+$/i

/**
 * Redacts a command line for display: home becomes `~`, values that follow
 * a secret-looking flag or sit in a secret-looking assignment are masked, and
 * the result is truncated to 160 characters. The preview is display-only and
 * never becomes an event payload or telemetry.
 */
export function redactCommand(command: string, home: string | undefined): string {
  const tokens = homeRelative(command, home).split(/\s+/).filter(Boolean)
  const out: string[] = []
  let maskNext = false
  for (const token of tokens) {
    if (maskNext) {
      out.push('••••')
      maskNext = false
      continue
    }
    const assignment = SECRET_ASSIGNMENT.exec(token)
    if (assignment) {
      out.push(`${assignment[1]}=••••`)
      continue
    }
    out.push(token)
    if (SECRET_FLAG.test(token)) maskNext = true
  }
  return bounded(out.join(' '), COMMAND_PREVIEW_MAX)
}

export function displayLabel(executableIdentity: string): string {
  const name = basename(executableIdentity) || executableIdentity
  return bounded(name, LABEL_MAX)
}

/** Matches a process against the enabled harness executables. A shim such as
 * `node /opt/homebrew/bin/claude` matches on its first script argument. */
export function harnessFor(
  row: Pick<ProcessListingRow, 'executableIdentity'>,
  args: string | undefined,
  enabled: readonly string[]
): string | undefined {
  const names = new Set<string>([basename(row.executableIdentity)])
  const argv = (args ?? '').split(/\s+/).filter(Boolean)
  for (const token of argv.slice(0, 2)) names.add(basename(token))
  for (const harness of enabled) {
    const executables = HARNESS_EXECUTABLES[harness]
    if (executables?.some((name) => names.has(name))) return harness
  }
  return undefined
}

/** Detects an app driven by automation from proof the process carries itself:
 * its executable name or its automation command-line flags. */
export function automationLabel(
  row: Pick<ProcessListingRow, 'executableIdentity'>,
  args: string | undefined
): string | undefined {
  const exe = row.executableIdentity
  if (exe.includes('Chrome for Testing')) return 'Chrome for Testing'
  if (/\/Simulator\.app\//.test(exe)) return 'Simulator'
  const argv = args ?? ''
  if (
    /(^|\s)--(enable-automation|remote-debugging-port(=\S+)?|remote-debugging-pipe)(\s|$)/.test(
      argv
    )
  ) {
    return /chromium/i.test(exe) ? 'Chromium automation' : 'Browser automation'
  }
  return undefined
}

/** Matches an executable basename or app name against a protected entry.
 * An entry ending in `*` is a prefix (`com.docker.*`). */
export function matchesProtectedEntry(name: string, entry: string): boolean {
  if (entry.endsWith('*')) return name.startsWith(entry.slice(0, -1))
  return name === entry
}

export type ProtectionContext = Readonly<{
  selfUid: number
  /** The Adea shell, its descendants, and its ancestors. */
  adeaPids: ReadonlySet<number>
  protectedExecutables: readonly string[]
}>

export function protectionFor(
  row: Pick<ProcessListingRow, 'pid' | 'uid' | 'executableIdentity'>,
  context: ProtectionContext
): ForeignProcessProtection {
  if (row.uid !== context.selfUid) return 'other_user'
  const name = basename(row.executableIdentity)
  if (
    row.pid <= 1 ||
    context.adeaPids.has(row.pid) ||
    SYSTEM_NAMES.has(name) ||
    SYSTEM_PATH_PREFIXES.some((prefix) => row.executableIdentity.startsWith(prefix))
  )
    return 'system'
  const appName = /\/([^/]+)\.app\//.exec(row.executableIdentity)?.[1]
  if (
    context.protectedExecutables.some(
      (entry) =>
        matchesProtectedEntry(name, entry) ||
        (appName !== undefined && matchesProtectedEntry(appName, entry))
    )
  )
    return 'protected_list'
  return 'none'
}

export function foreignProcessId(
  row: Pick<ProcessListingRow, 'pid' | 'startIdentity' | 'executableIdentity'>
): string {
  const digest = createHash('sha256')
    .update(`${row.pid}\u0000${row.startIdentity}\u0000${row.executableIdentity}`)
    .digest('hex')
  return `fp-${digest.slice(0, 32)}`
}

/** Evenly spaced points over the window, at most `count` of them. */
export function downsample<T>(points: readonly T[], count: number): T[] {
  if (points.length <= count) return [...points]
  const out: T[] = []
  for (let index = 0; index < count; index += 1) {
    out.push(points[Math.round((index * (points.length - 1)) / (count - 1))] as T)
  }
  return out
}

/** A child of a foreign row, captured so the stop path can re-prove it. */
export type ForeignMember = Readonly<{
  pid: number
  uid: number
  startIdentity: string
  executableIdentity: string
}>

/** The latest observation of one foreign row plus what the stop path needs. */
export type ForeignObservation = Readonly<{
  record: ForeignProcessRecord
  root: ForeignMember
  /** Descendants, deepest first, so the stop path signals children first. */
  members: readonly ForeignMember[]
}>

export type MachineStats = Readonly<{
  memoryTotalBytes?: number
  memoryFreeBytes?: number
  /** Cumulative CPU times across all cores (any unit, deltas are used). */
  cpuTimes?: Readonly<{ idle: number; total: number }>
  disk?: Readonly<{ freeBytes: number; totalBytes: number }>
}>

export function defaultMachineStats(home: string): MachineStats {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    const times = cpu.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  let disk: MachineStats['disk']
  try {
    const stats = statfsSync(home)
    disk = { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }
  } catch {
    disk = undefined
  }
  return {
    memoryTotalBytes: totalmem(),
    memoryFreeBytes: freemem(),
    ...(total > 0 ? { cpuTimes: { idle, total } } : {}),
    ...(disk ? { disk } : {}),
  }
}

export type MachineInventoryInput = Readonly<{
  run: CappedCommandRunner
  preferences: () => ResourcePreferences
  /** Live PIDs of Adea-proven launches. They are never foreign; descendants
   * that run under a shell in an Adea terminal are listed (no launch record
   * proves them), everything else in the Adea tree stays excluded. */
  ownedPids: () => ReadonlySet<number>
  /** Registered worktree roots, so a row's working directory names its worktree. */
  worktreeRoots?: () => readonly Readonly<{ id: string; root: string }>[]
  selfPid?: number
  selfUid?: number
  home?: string
  machineStats?: () => MachineStats
  now?: () => number
}>

export type MachineObservation = Readonly<{
  foreign: readonly ForeignProcessRecord[]
  machine: MachineResourceSummary
}>

export type MachineInventory = Readonly<{
  /** One bounded pull. Returns undefined fields rather than fabricated ones. */
  observe(): Promise<MachineObservation>
  /** The latest observation of a foreign row, for the stop path. */
  lookup(id: string): ForeignObservation | undefined
  /** Re-evaluates protection for a live identity against current preferences. */
  protection(member: ForeignMember): ForeignProcessProtection
}>

type HistoryPoint = { at: number; bytes: number }

export function createMachineInventory(input: MachineInventoryInput): MachineInventory {
  const now = input.now ?? Date.now
  const selfPid = input.selfPid ?? process.pid
  const selfUid = input.selfUid ?? process.getuid?.() ?? -1
  const home = input.home ?? homedir()
  const machineStats = input.machineStats ?? (() => defaultMachineStats(home))

  let pulls = 0
  const generations = new Map<string, number>()
  const history = new Map<string, HistoryPoint[]>()
  const cpuPrevious = new Map<string, { at: number; seconds: number }>()
  const cwdCache = new Map<string, string | null>()
  let listenerCache: { at: number; byPid: Map<number, number[]> | undefined } | undefined
  let latest = new Map<string, ForeignObservation>()
  let previousCpuTimes: MachineStats['cpuTimes']
  let adeaPids: ReadonlySet<number> = new Set([selfPid])

  async function listeners(prefs: ResourcePreferences): Promise<Map<number, number[]> | undefined> {
    const interval = Math.max(MIN_LISTENER_SCAN_INTERVAL_MS, prefs.sampling.visibleSeconds * 1000)
    if (listenerCache && now() - listenerCache.at < interval) return listenerCache.byPid
    const result = await input.run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
    // lsof exits 1 when nothing matches; that is an empty, truthful answer.
    const trustworthy =
      !result.timedOut &&
      !result.truncated &&
      !result.spawnFailed &&
      (result.exitCode === 0 || (result.exitCode === 1 && result.stdout.trim() === ''))
    let byPid: Map<number, number[]> | undefined
    if (trustworthy) {
      byPid = new Map()
      for (const service of parseLsofOutput(result.stdout)) {
        if (service.pid === null) continue
        if (service.port < prefs.portRange.from || service.port > prefs.portRange.to) continue
        const ports = byPid.get(service.pid) ?? []
        if (ports.length < 64) ports.push(service.port)
        byPid.set(service.pid, ports)
      }
    }
    listenerCache = { at: now(), byPid }
    return byPid
  }

  function summary(): MachineResourceSummary {
    const stats = machineStats()
    let cpuPercent: number | undefined
    if (stats.cpuTimes && previousCpuTimes) {
      const total = stats.cpuTimes.total - previousCpuTimes.total
      const idle = stats.cpuTimes.idle - previousCpuTimes.idle
      if (total > 0) cpuPercent = Math.min(100, Math.max(0, ((total - idle) / total) * 100))
    }
    previousCpuTimes = stats.cpuTimes
    const used =
      stats.memoryTotalBytes !== undefined && stats.memoryFreeBytes !== undefined
        ? Math.max(0, stats.memoryTotalBytes - stats.memoryFreeBytes)
        : undefined
    return {
      ...(stats.memoryTotalBytes !== undefined
        ? { memoryTotalBytes: String(Math.floor(stats.memoryTotalBytes)) }
        : {}),
      ...(used !== undefined ? { memoryUsedBytes: String(Math.floor(used)) } : {}),
      ...(cpuPercent !== undefined ? { cpuPercent } : {}),
      ...(stats.disk
        ? {
            diskFreeBytes: String(Math.floor(stats.disk.freeBytes)),
            diskTotalBytes: String(Math.floor(stats.disk.totalBytes)),
          }
        : {}),
      observedAt: new Date(now()).toISOString(),
    }
  }

  async function cwdFor(pids: readonly number[]): Promise<Map<number, string>> {
    if (pids.length === 0) return new Map()
    const result = await input.run([
      'lsof',
      '-a',
      '-d',
      'cwd',
      '-nP',
      '-F',
      'pn',
      '-p',
      pids.join(','),
    ])
    if (result.timedOut || result.truncated || result.spawnFailed) return new Map()
    return parseCwdListing(result.stdout)
  }

  async function observe(): Promise<MachineObservation> {
    const prefs = input.preferences()
    const machine = summary()
    if (prefs.coverage !== 'machine') {
      latest = new Map()
      return { foreign: [], machine }
    }
    pulls += 1
    const listing = await input.run([
      'ps',
      '-axww',
      '-o',
      'pid=,ppid=,uid=,rss=,time=,lstart=,comm=',
    ])
    if (!completed(listing)) {
      // An incomplete listing proves nothing about which processes exist.
      latest = new Map()
      return { foreign: [], machine }
    }
    const rows = parseProcessListing(listing.stdout)
    const argsResult = await input.run(['ps', '-axww', '-o', 'pid=,args='])
    const args = completed(argsResult)
      ? parseArgsListing(argsResult.stdout)
      : new Map<number, string>()
    const listenerPorts = await listeners(prefs)

    const byPid = new Map(rows.map((row) => [row.pid, row]))
    const children = new Map<number, number[]>()
    for (const row of rows) {
      if (row.ppid === row.pid) continue
      const list = children.get(row.ppid) ?? []
      list.push(row.pid)
      children.set(row.ppid, list)
    }
    const descendants = (root: number): number[] => {
      const out: number[] = []
      const stack = [...(children.get(root) ?? [])]
      while (stack.length > 0 && out.length < 4096) {
        const pid = stack.pop() as number
        out.push(pid)
        stack.push(...(children.get(pid) ?? []))
      }
      return out
    }

    // The Adea tree: the shell, everything it or a proven launch started.
    // Inside it, a process below an interactive shell was started by the user
    // in an Adea terminal and is listed; the rest (helpers, sidecars, the
    // shells themselves) is Adea's own and stays excluded.
    const owned = new Set(input.ownedPids())
    const adeaTree = new Set<number>([selfPid, ...descendants(selfPid)])
    for (const pid of owned) {
      adeaTree.add(pid)
      for (const child of descendants(pid)) adeaTree.add(child)
    }
    const inAdeaTerminal = new Set<number>()
    for (const pid of adeaTree) {
      if (pid === selfPid || owned.has(pid)) continue
      for (
        let cursor = byPid.get(byPid.get(pid)?.ppid ?? -1), hops = 0;
        cursor && hops < 64 && adeaTree.has(cursor.pid);
        hops += 1
      ) {
        if (SHELL_NAMES.has(basename(cursor.executableIdentity).replace(/^-/, ''))) {
          inAdeaTerminal.add(pid)
          break
        }
        if (cursor.pid === selfPid || owned.has(cursor.pid)) break
        cursor = byPid.get(cursor.ppid)
      }
    }
    const adea = new Set<number>([...adeaTree].filter((pid) => !inAdeaTerminal.has(pid)))
    for (
      let pid = byPid.get(selfPid)?.ppid, hops = 0;
      pid !== undefined && pid > 0 && hops < 64;
      hops += 1
    ) {
      adea.add(pid)
      pid = byPid.get(pid)?.ppid
    }
    adeaPids = adea
    const excluded = (pid: number) => adeaTree.has(pid) && !inAdeaTerminal.has(pid)

    const context: ProtectionContext = {
      selfUid,
      adeaPids: adea,
      protectedExecutables: prefs.protectedExecutables,
    }

    // Candidate roots: listeners, automation apps (tree tops only), then the
    // largest remaining Adea-user processes.
    const emitted = new Set<number>()
    if (listenerPorts) {
      for (const pid of listenerPorts.keys()) if (byPid.has(pid) && !excluded(pid)) emitted.add(pid)
    }
    const automation = new Map<number, string>()
    if (prefs.includeAutomationApps) {
      for (const row of rows) {
        if (excluded(row.pid)) continue
        const label = automationLabel(row, args.get(row.pid))
        if (!label) continue
        const parent = byPid.get(row.ppid)
        if (parent && automationLabel(parent, args.get(parent.pid))) continue
        automation.set(row.pid, label)
        emitted.add(row.pid)
      }
    }
    const covered = new Set<number>()
    for (const pid of emitted) for (const child of descendants(pid)) covered.add(child)
    const largest = rows
      .filter(
        (row) =>
          row.uid === selfUid &&
          !emitted.has(row.pid) &&
          !covered.has(row.pid) &&
          !excluded(row.pid) &&
          !adea.has(row.pid)
      )
      .toSorted((left, right) => right.residentBytes - left.residentBytes)
      .slice(0, MAX_LARGEST_FOREIGN_ROWS)
    for (const row of largest) emitted.add(row.pid)

    const worktreeRoots = input.worktreeRoots?.() ?? []
    const roots = [...emitted].slice(0, MAX_FOREIGN_ROWS)
    const rootSet = new Set(roots)
    const at = now()

    const newCwdPids = roots.filter((pid) => {
      const row = byPid.get(pid) as ProcessListingRow
      return !cwdCache.has(foreignProcessId(row))
    })
    const cwd = await cwdFor(newCwdPids)
    for (const pid of newCwdPids) {
      const row = byPid.get(pid) as ProcessListingRow
      cwdCache.set(foreignProcessId(row), cwd.get(pid) ?? null)
    }

    const next = new Map<string, ForeignObservation>()
    const records: ForeignProcessRecord[] = []
    for (const pid of roots) {
      const row = byPid.get(pid) as ProcessListingRow
      const id = foreignProcessId(row)
      if (!generations.has(id)) generations.set(id, pulls)
      // The tree folds in descendants that are not themselves listed rows.
      const tree: ProcessListingRow[] = []
      const stack = [...(children.get(pid) ?? [])]
      while (stack.length > 0 && tree.length < 4096) {
        const childPid = stack.pop() as number
        if (rootSet.has(childPid)) continue
        const child = byPid.get(childPid)
        if (!child) continue
        tree.push(child)
        stack.push(...(children.get(childPid) ?? []))
      }
      const treeBytes = tree.reduce((sum, child) => sum + child.residentBytes, row.residentBytes)

      let cpuPercent: number | undefined
      const cpuSeconds = [row, ...tree].every((member) => member.cpuSeconds !== undefined)
        ? [row, ...tree].reduce((sum, member) => sum + (member.cpuSeconds as number), 0)
        : undefined
      const previous = cpuPrevious.get(id)
      if (cpuSeconds !== undefined) {
        if (previous && at > previous.at && cpuSeconds >= previous.seconds) {
          cpuPercent = ((cpuSeconds - previous.seconds) / ((at - previous.at) / 1000)) * 100
        }
        cpuPrevious.set(id, { at, seconds: cpuSeconds })
      }

      const points = (history.get(id) ?? []).filter(
        (point) => at - point.at <= FOREIGN_HISTORY_WINDOW_MS
      )
      points.push({ at, bytes: treeBytes })
      history.set(id, points)

      let attribution: ForeignProcessAttribution = { kind: 'unknown' }
      const automationName = automation.get(pid)
      if (automationName) attribution = { kind: 'automation', label: automationName }
      else {
        for (
          let cursor: ProcessListingRow | undefined = row, hops = 0;
          cursor && hops <= MAX_ATTRIBUTION_HOPS;
          hops += 1
        ) {
          const harness = harnessFor(cursor, args.get(cursor.pid), prefs.recognizedHarnesses)
          if (harness) {
            attribution = { kind: 'harness', harness }
            break
          }
          cursor = cursor.ppid !== cursor.pid ? byPid.get(cursor.ppid) : undefined
        }
        if (attribution.kind === 'unknown' && inAdeaTerminal.has(pid))
          attribution = { kind: 'adea_terminal' }
      }

      const protection = protectionFor(row, context)
      const command = args.get(pid)
      const cwdText = cwdCache.get(id) ?? undefined
      const worktreeId = worktreeForCwd(cwdText, worktreeRoots)
      const record: ForeignProcessRecord = {
        id,
        observationGeneration: generations.get(id) as number,
        pid,
        startIdentity: row.startIdentity,
        executableIdentity: bounded(row.executableIdentity, 1024),
        label: displayLabel(row.executableIdentity),
        ...(command ? { commandPreview: redactCommand(command, home) } : {}),
        ...(cwdText ? { cwdLabel: bounded(homeRelative(cwdText, home), COMMAND_PREVIEW_MAX) } : {}),
        ...(worktreeId !== undefined ? { worktreeId } : {}),
        attribution,
        listeningPorts: [...(listenerPorts?.get(pid) ?? [])].toSorted((a, b) => a - b),
        childCount: tree.length,
        residentBytes: String(treeBytes),
        ...(cpuPercent !== undefined ? { cpuPercent } : {}),
        residentHistory: downsample(points, FOREIGN_HISTORY_POINTS).map((point) =>
          String(point.bytes)
        ),
        protection,
        stoppable: protection === 'none' && row.uid === selfUid,
        observedAt: new Date(at).toISOString(),
      }
      records.push(record)
      const memberOf = (member: ProcessListingRow): ForeignMember => ({
        pid: member.pid,
        uid: member.uid,
        startIdentity: member.startIdentity,
        executableIdentity: member.executableIdentity,
      })
      next.set(id, {
        record,
        root: memberOf(row),
        // `tree` is in discovery order (parents before children); reversing
        // it puts the deepest descendants first.
        members: tree.map(memberOf).toReversed(),
      })
    }

    // Forget rows that disappeared so history and caches stay bounded.
    for (const id of history.keys()) if (!next.has(id)) history.delete(id)
    for (const id of cpuPrevious.keys()) if (!next.has(id)) cpuPrevious.delete(id)
    for (const id of cwdCache.keys()) if (!next.has(id)) cwdCache.delete(id)
    for (const id of generations.keys()) if (!next.has(id)) generations.delete(id)
    latest = next

    records.sort((left, right) => {
      const ports = Number(right.listeningPorts.length > 0) - Number(left.listeningPorts.length > 0)
      if (ports !== 0) return ports
      return Number(right.residentBytes ?? 0) - Number(left.residentBytes ?? 0)
    })
    return { foreign: records, machine }
  }

  return Object.freeze({
    observe,
    lookup: (id: string) => latest.get(id),
    protection: (member: ForeignMember) =>
      protectionFor(member, {
        selfUid,
        adeaPids,
        protectedExecutables: input.preferences().protectedExecutables,
      }),
  })
}
