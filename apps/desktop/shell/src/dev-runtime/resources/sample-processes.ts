// Bounded OS metric sampling for supervised PIDs (#424).
//
// Sampling is pull-based and read-only: one fixed-argv `ps` observation per
// pull (`ps -o pid=,time=,rss= -p <pids>`), never a timer, never a signal,
// never a shell string. `time` is the OS cumulative CPU time (the metrics
// history derives percentages from consecutive deltas) and `rss` is the
// resident set size in 1 KiB units on both darwin and Linux. The bounds follow
// the Dev Runtime spec's metric defaults: a 5-second command timeout, a 1 MiB
// output cap, and a bounded PID list per invocation.
//
// Truthfulness bar: only rows ps actually reported become samples — a PID
// that vanished between listing and sampling, or an unparseable row, is
// simply absent (never a fabricated zero). A failed or oversized observation
// leaves the sample set empty; the caller records absence truthfully.
import type { ResourceSample } from './metrics'

export const SAMPLE_COMMAND_TIMEOUT_MS = 5_000
export const SAMPLE_MAX_OUTPUT_BYTES = 1024 * 1024
/** Bounded PID list per invocation (spec: bounded sampling, never a scan). */
export const SAMPLE_MAX_PIDS = 64

export type PsRunResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>

/** Injectable host transport: fixed argv in, observed output out. Tests
 *  script this; production spawns `ps` verbatim (no shell, bounded time). */
export type ProcessSampleRunner = (args: readonly string[]) => Promise<PsRunResult>

export type ProcessSamplerInput = Readonly<{
  runPs?: ProcessSampleRunner
  maxPids?: number
}>

export type ProcessSampler = (pids: readonly number[]) => Promise<readonly ResourceSample[]>

function defaultRunPs(args: readonly string[]): Promise<PsRunResult> {
  const proc = Bun.spawnSync(['ps', ...args], {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: SAMPLE_COMMAND_TIMEOUT_MS,
  })
  return Promise.resolve({
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: '',
  })
}

/**
 * Parse one cumulative CPU-time display value ("mm:ss", "hh:mm:ss",
 * "dd-hh:mm:ss", with darwin's fractional second tail) into seconds.
 * Anything else is unparseable and yields undefined — never a guess.
 */
export function parseCpuSeconds(text: string): number | undefined {
  let value = text.trim()
  if (value.length === 0) return undefined
  let days = 0
  const dash = value.indexOf('-')
  if (dash > 0) {
    const head = value.slice(0, dash)
    if (!/^\d+$/.test(head)) return undefined
    days = Number(head)
    value = value.slice(dash + 1)
  }
  const parts = value.split(':')
  if (parts.length === 0 || parts.length > 3) return undefined
  let seconds = 0
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) return undefined
    seconds = seconds * 60 + Number(part)
  }
  return days * 86_400 + seconds
}

function parseSampleRow(line: string): ResourceSample | undefined {
  const tokens = line.trim().split(/\s+/)
  if (tokens.length < 3) return undefined
  const pid = Number(tokens[0])
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const cpuSeconds = parseCpuSeconds(tokens[1] ?? '')
  const rssKib = Number(tokens[2])
  if (cpuSeconds === undefined || !Number.isSafeInteger(rssKib) || rssKib < 0) return undefined
  return {
    pid,
    cpuSeconds,
    residentBytes: rssKib * 1024,
  }
}

/**
 * The production sampler seam: `sampleProcesses(pids)` returns what one
 * bounded `ps` observation proves for the requested PIDs. Rows for PIDs that
 * no longer exist are absent from the reply; a failed observation resolves
 * to an empty set (absence is truthful, never zero).
 */
export function createProcessSampler(input: ProcessSamplerInput = {}): ProcessSampler {
  const runPs = input.runPs ?? defaultRunPs
  const maxPids =
    input.maxPids !== undefined && Number.isSafeInteger(input.maxPids) && input.maxPids > 0
      ? input.maxPids
      : SAMPLE_MAX_PIDS
  let nextIndex = 0
  return async (pids) => {
    const unique = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    if (unique.length === 0) return []
    // Preserve one bounded `ps` call per pull while moving through the full
    // inventory. Repeated snapshots of a stable large list eventually observe
    // every PID instead of permanently sampling only its first 64 entries.
    const count = Math.min(unique.length, maxPids)
    const selected = Array.from(
      { length: count },
      (_, offset) => unique[(nextIndex + offset) % unique.length]!
    )
    nextIndex = (nextIndex + count) % unique.length
    let result: PsRunResult
    try {
      result = await runPs(['-o', 'pid=,time=,rss=', '-p', selected.join(',')])
    } catch {
      return []
    }
    // An oversized observation is refused as a whole: parsing a truncated
    // buffer could half-report processes. Bounded bounds keep this unreachable.
    if (Buffer.byteLength(result.stdout, 'utf8') > SAMPLE_MAX_OUTPUT_BYTES) return []
    const byPid = new Map<number, ResourceSample>()
    for (const line of result.stdout.split('\n')) {
      if (line.trim().length === 0) continue
      const sample = parseSampleRow(line)
      if (sample) byPid.set(sample.pid, sample)
    }
    // Only requested PIDs come back, and only ones ps actually reported.
    return selected.flatMap((pid) => {
      const sample = byPid.get(pid)
      return sample ? [sample] : []
    })
  }
}
