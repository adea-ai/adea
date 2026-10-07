/*
 * Pure view-model for the runtime resources sheet: the overview bars, the
 * attention banner, server rows grouped by worktree, storage rows, the
 * clean-up candidate list, and leak detection.
 *
 * The rules mirror the host's authority boundary. A row is stoppable only
 * when the host says so (a running proven launch, or a foreign row the host
 * marked `stoppable`); the sheet never decides ownership or protection. A
 * value the host could not observe stays `undefined` and renders as unknown,
 * never as zero. Clean-up pre-selection is limited to Adea's own servers and
 * archived Adea worktrees: leaking servers, protected rows, and processes Adea
 * did not start are never pre-selected.
 */
import type {
  ForeignProcessRecord,
  MachineResourceSummary,
  PortRecord,
  ProcessRecord,
  ResourceMetric,
  ResourcePreferences,
  ResourcePreferencesInput,
  ResourceSnapshot,
  RetainedDataRecord,
  Worktree,
  WorktreeStorageRecord,
} from '@adea-ai/types/dev-runtime'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

/** Mirrors the host defaults; used until the host answers with stored settings. */
export const FALLBACK_PREFERENCES: ResourcePreferencesInput = {
  coverage: 'machine',
  includeAutomationApps: true,
  recognizedHarnesses: ['Claude Code', 'Codex', 'OpenCode', 'Hermes', 'Cursor'],
  portRange: { from: 1024, to: 65_535 },
  alerts: {
    residentBytesAbove: String(2 * GiB),
    growthBytes: String(500 * MiB),
    growthWindowSeconds: 600,
    notify: 'badge',
    snoozeSeconds: 3600,
  },
  cleanup: {
    mode: 'ask',
    serverIdleSeconds: 4 * 3600,
    suggestMergedWorktreesAfterSeconds: 3 * 86_400,
    quarantineRetentionSeconds: 7 * 86_400,
    retainedDataRetentionSeconds: 14 * 86_400,
  },
  protectedExecutables: ['postgres', 'redis-server', 'mysqld', 'com.docker.*', 'ollama'],
  sampling: { visibleSeconds: 2, backgroundSeconds: 60 },
}

/** Every harness the host ships a matcher for (the host drops anything else). */
export const KNOWN_HARNESSES = [
  'Claude Code',
  'Codex',
  'OpenCode',
  'Hermes',
  'Cursor',
  'Aider',
  'Gemini CLI',
] as const

/** True when a reply really is a stored preference document. Hosts that do not
 * implement the operation may answer with an empty object. */
export function isResourcePreferences(value: unknown): value is ResourcePreferences {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<ResourcePreferences>
  return (
    (item.coverage === 'machine' || item.coverage === 'adea') &&
    typeof item.version === 'number' &&
    typeof item.alerts === 'object' &&
    typeof item.cleanup === 'object' &&
    typeof item.sampling === 'object' &&
    Array.isArray(item.protectedExecutables) &&
    Array.isArray(item.recognizedHarnesses)
  )
}

/** The editable part of a stored document. */
export function preferencesInput(value: ResourcePreferences): ResourcePreferencesInput {
  return {
    coverage: value.coverage,
    includeAutomationApps: value.includeAutomationApps,
    recognizedHarnesses: value.recognizedHarnesses,
    portRange: value.portRange,
    alerts: value.alerts,
    cleanup: value.cleanup,
    protectedExecutables: value.protectedExecutables,
    sampling: value.sampling,
  }
}

function bytes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export function formatSize(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < MiB) return `${Math.round(value / 1024)} KB`
  if (value < GiB) return `${Math.round(value / MiB)} MB`
  return `${(value / GiB).toFixed(value >= 100 * GiB ? 0 : value >= 10 * GiB ? 1 : 2)} GB`
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`
}

export function formatAge(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  const minutes = Math.floor(milliseconds / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 21) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

export type LeakState = Readonly<{
  kind: 'normal' | 'over_limit' | 'growing'
  /** Growth over the configured window when `growing`. */
  growthBytes?: number
  /** The configured growth window the growth was measured over, when `growing`. */
  windowSeconds?: number
}>

/** A whole-unit duration such as `10 min`, `2 h`, or `90 s`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 120) return `${Math.round(seconds)} s`
  const minutes = seconds / 60
  if (minutes < 120) return `${Math.round(minutes)} min`
  const hours = minutes / 60
  if (hours < 48) return `${Math.round(hours)} h`
  return `${Math.round(hours / 24)} d`
}

/** The leak line for a row: the growth names the window it happened in. */
export function leakText(leak: LeakState): string | undefined {
  if (leak.kind === 'growing') {
    const window =
      leak.windowSeconds !== undefined ? ` in ${formatDuration(leak.windowSeconds)}` : ''
    return `Leaking · +${formatSize(leak.growthBytes)}${window}`
  }
  if (leak.kind === 'over_limit') return 'Over your memory limit'
  return undefined
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Parses a `ps -o lstart=` start identity (`Tue Oct  6 09:14:03 2026`, local
 * time) into epoch milliseconds; anything else is unknown. */
export function parseStartIdentity(text: string): number | undefined {
  const match =
    /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
      text.trim()
    )
  if (!match) return undefined
  const month = MONTHS.indexOf(match[1] as string)
  if (month < 0) return undefined
  const at = new Date(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  ).getTime()
  return Number.isFinite(at) ? at : undefined
}

/** `2h ago · Oct 6, 2026, 9:14 AM` in the viewer's locale; the raw identity
 * when it cannot be read. */
export function startedLabel(startIdentity: string, now: number): string {
  const at = parseStartIdentity(startIdentity)
  if (at === undefined) return startIdentity
  const age = formatAge(now - at)
  const when = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(at))
  return `${age === 'now' || age === '—' ? 'just now' : `${age} ago`} · ${when}`
}

/** `up 2h`, or `just started` under a minute. */
export function uptimeLabel(startedAt: number, now: number): string {
  const age = formatAge(now - startedAt)
  if (age === '—') return 'Running'
  return age === 'now' ? 'just started' : `up ${age}`
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

export type BytePoint = Readonly<{ at: number; bytes: number }>

/** Over the memory limit, or growing faster than the configured rate. */
export function leakState(
  points: readonly BytePoint[],
  alerts: ResourcePreferencesInput['alerts']
): LeakState {
  const latest = points.at(-1)
  if (!latest) return { kind: 'normal' }
  const windowStart = latest.at - alerts.growthWindowSeconds * 1000
  const inWindow = points.filter((point) => point.at >= windowStart)
  const lowest = Math.min(...inWindow.map((point) => point.bytes))
  const growth = latest.bytes - lowest
  const growthLimit = Number(alerts.growthBytes)
  if (inWindow.length >= 2 && Number.isFinite(growthLimit) && growth >= growthLimit)
    return { kind: 'growing', growthBytes: growth, windowSeconds: alerts.growthWindowSeconds }
  const limit = Number(alerts.residentBytesAbove)
  if (Number.isFinite(limit) && latest.bytes >= limit) return { kind: 'over_limit' }
  return { kind: 'normal' }
}

/** SVG polyline points for a sparkline in a `width`×`height` box. */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return ''
  const series = values.length === 1 ? [values[0] as number, values[0] as number] : values
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || 1
  return series
    .map((value, index) => {
      const x = (index / (series.length - 1)) * width
      const y = height - 1 - ((value - min) / span) * (height - 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

export type TrendPoint = Readonly<{ at: number; value: number }>

export type TrendGeometry = Readonly<{
  /** Polyline points in a `width`×`height` box; empty without samples. */
  points: string
  /** The threshold's y coordinate, when it falls inside the drawn range. */
  thresholdY?: number
  /** Time-axis labels: how long ago the first sample was, and the last. */
  startLabel: string
  endLabel: string
}>

/** A history chart with a time axis and an optional threshold line. The value
 * axis starts at zero and stretches to the threshold when the threshold is
 * within twice the highest sample, so a nearby limit is drawn to scale and a
 * far-away one does not flatten the trend. */
export function trendGeometry(
  samples: readonly TrendPoint[],
  options: { width: number; height: number; threshold?: number; now?: number }
): TrendGeometry {
  const { width, height } = options
  const first = samples[0]
  const last = samples.at(-1)
  if (!first || !last) return { points: '', startLabel: '', endLabel: '' }
  const highest = Math.max(...samples.map((sample) => sample.value))
  const threshold =
    options.threshold !== undefined &&
    Number.isFinite(options.threshold) &&
    options.threshold > 0 &&
    options.threshold <= highest * 2
      ? options.threshold
      : undefined
  const top = Math.max(highest, threshold ?? 0) * 1.05 || 1
  const span = last.at - first.at
  const y = (value: number) => height - 1 - (value / top) * (height - 2)
  const series = samples.length === 1 ? [first, { ...first, at: first.at + 1 }] : samples
  const seriesSpan = (series.at(-1) as TrendPoint).at - (series[0] as TrendPoint).at || 1
  const points = series
    .map((sample) => {
      const x = ((sample.at - (series[0] as TrendPoint).at) / seriesSpan) * width
      return `${x.toFixed(1)},${y(sample.value).toFixed(1)}`
    })
    .join(' ')
  const now = options.now ?? last.at
  const ago = (at: number) => {
    const seconds = Math.max(0, (now - at) / 1000)
    return seconds < 1 ? 'now' : `${formatDuration(seconds)} ago`
  }
  return {
    points,
    ...(threshold !== undefined ? { thresholdY: Number(y(threshold).toFixed(1)) } : {}),
    startLabel: span > 0 ? ago(first.at) : ago(last.at),
    endLabel: ago(last.at),
  }
}

export type OwnedServerRow = Readonly<{
  kind: 'owned'
  id: string
  record: ProcessRecord
  title: string
  detail: string
  /** The executable the launch runs (its basename). */
  command: string
  /** Epoch milliseconds the process started, when the start identity reads. */
  startedAt?: number
  /** Short label for the runtime session that owns it, when it has one. */
  sessionLabel?: string
  /** The project of its worktree, when the worktree is registered. */
  projectId?: string
  ports: readonly PortRecord[]
  residentBytes?: number
  cpuPercent?: number
  history: readonly BytePoint[]
  cpuHistory: readonly number[]
  /** CPU samples with their observation times, for the detail chart. */
  cpuPoints: readonly TrendPoint[]
  leak: LeakState
  worktreeId?: string
  stoppable: boolean
  previewUrl?: string
}>

export type ForeignServerRow = Readonly<{
  kind: 'foreign'
  id: string
  record: ForeignProcessRecord
  title: string
  detail: string
  /** A short badge naming who started it, when known. */
  attributionLabel?: string
  ports: readonly number[]
  residentBytes?: number
  cpuPercent?: number
  history: readonly BytePoint[]
  leak: LeakState
  worktreeId?: string
  stoppable: boolean
}>

export type ServerRow = OwnedServerRow | ForeignServerRow

export type ServerGroup = Readonly<{
  id: string
  kind: 'worktree' | 'missing_worktree' | 'adea' | 'elsewhere' | 'protected'
  title: string
  subtitle: string
  totalBytes?: number
  rows: readonly ServerRow[]
}>

const OWNER_LABELS: Record<ProcessRecord['ownerKind'], string> = {
  terminal: 'Terminal',
  harness: 'Agent',
  server: 'Server',
  browser: 'Browser',
  device: 'Device',
  bootstrap: 'Bootstrap',
  git: 'Git',
}

export const STATE_LABELS: Record<ProcessRecord['state'], string> = {
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  exited: 'Exited',
  unknown: 'Identity unproven',
}

export function worktreeTitle(worktree: Worktree): string {
  if (worktree.title) return worktree.title
  if (worktree.branchRef) return worktree.branchRef.replace(/^refs\/heads\//, '')
  if (worktree.kind === 'primary') return 'Primary checkout'
  return worktree.id
}

export function attributionLabel(record: ForeignProcessRecord): string | undefined {
  switch (record.attribution.kind) {
    case 'harness':
      return record.attribution.harness
    case 'automation':
      return record.attribution.label
    case 'adea_terminal':
      return 'Adea terminal'
    default:
      return undefined
  }
}

function metricPoints(metrics: readonly ResourceMetric[], record: ProcessRecord) {
  const points = metrics
    .filter(
      (point) =>
        point.processRecordId === record.id &&
        (point.generation === undefined || point.generation === record.generation)
    )
    .toSorted((left, right) => left.observedAt.localeCompare(right.observedAt))
  const history: BytePoint[] = []
  const cpuHistory: number[] = []
  const cpuPoints: TrendPoint[] = []
  let cpuPercent: number | undefined
  for (const point of points) {
    const at = Date.parse(point.observedAt)
    const resident = bytes(point.residentBytes)
    if (resident !== undefined) history.push({ at, bytes: resident })
    if (point.cpuPercent !== undefined) {
      cpuPercent = point.cpuPercent
      cpuHistory.push(point.cpuPercent)
      cpuPoints.push({ at, value: point.cpuPercent })
    }
  }
  return { history, cpuHistory, cpuPoints, cpuPercent }
}

/** Foreign resident history is evenly spaced over the host's 10-minute window. */
function foreignPoints(record: ForeignProcessRecord): BytePoint[] {
  const end = Date.parse(record.observedAt)
  const values = record.residentHistory.map(Number).filter((value) => Number.isFinite(value))
  if (values.length === 0) return []
  const step = values.length > 1 ? (10 * 60_000) / (values.length - 1) : 0
  return values.map((value, index) => ({
    at: end - (values.length - 1 - index) * step,
    bytes: value,
  }))
}

function sum(values: readonly (number | undefined)[]): number | undefined {
  let total = 0
  let any = false
  for (const value of values) {
    if (value === undefined) continue
    total += value
    any = true
  }
  return any ? total : undefined
}

/** `this session` for the session the sheet is scoped to, else a short id. */
export function sessionLabel(runtimeSessionId: string, currentSessionId?: string): string {
  if (runtimeSessionId === currentSessionId) return 'this session'
  return `session ${runtimeSessionId.slice(0, 8)}`
}

export function serverGroups(input: {
  snapshot: ResourceSnapshot | undefined
  worktrees: readonly Worktree[]
  alerts: ResourcePreferencesInput['alerts']
  /** Clock for uptime; defaults to the snapshot's observation time. */
  now?: number
  /** The session the sheet is scoped to, named `this session` on its rows. */
  currentSessionId?: string
  /** Titles of worktrees seen earlier, so a deleted worktree keeps its branch. */
  rememberedWorktreeTitles?: ReadonlyMap<string, string>
}): ServerGroup[] {
  const snapshot = input.snapshot
  if (!snapshot) return []
  const now = input.now ?? Date.parse(snapshot.observedAt)
  const worktreesById = new Map(input.worktrees.map((worktree) => [worktree.id, worktree]))
  const groups = new Map<
    string,
    { group: Omit<ServerGroup, 'rows' | 'totalBytes'>; rows: ServerRow[] }
  >()
  const groupFor = (id: string, init: () => Omit<ServerGroup, 'rows' | 'totalBytes'>) => {
    let entry = groups.get(id)
    if (!entry) {
      entry = { group: init(), rows: [] }
      groups.set(id, entry)
    }
    return entry.rows
  }
  const worktreeGroup = (worktreeId: string) => {
    const worktree = worktreesById.get(worktreeId)
    if (!worktree) {
      const remembered = input.rememberedWorktreeTitles?.get(worktreeId)
      return groupFor(`missing:${worktreeId}`, () => ({
        id: `missing:${worktreeId}`,
        kind: 'missing_worktree',
        title: remembered ?? 'Worktree deleted',
        subtitle: remembered
          ? 'Worktree deleted · its servers are orphaned'
          : 'Its servers are orphaned',
      }))
    }
    return groupFor(`worktree:${worktree.id}`, () => ({
      id: `worktree:${worktree.id}`,
      kind: 'worktree',
      title: worktreeTitle(worktree),
      subtitle: worktree.kind === 'primary' ? 'Checkout' : 'Worktree',
    }))
  }

  const claimedPorts = new Set<string>()
  for (const record of snapshot.processes) {
    if (record.state === 'exited') continue
    const ports = snapshot.ports.filter(
      (port) =>
        port.owner === 'adea' &&
        (port.processRecordId === record.id ||
          (port.processRecordId === undefined &&
            record.runtimeSessionId !== undefined &&
            port.runtimeSessionId === record.runtimeSessionId))
    )
    for (const port of ports) claimedPorts.add(port.id)
    const { history, cpuHistory, cpuPoints, cpuPercent } = metricPoints(snapshot.metrics, record)
    const previewUrl = ports.find((port) => port.preview !== undefined)?.preview?.url
    const command = basename(record.executableIdentity)
    const startedAt = parseStartIdentity(record.startIdentity)
    const session =
      record.runtimeSessionId !== undefined
        ? sessionLabel(record.runtimeSessionId, input.currentSessionId)
        : undefined
    const projectId =
      record.worktreeId !== undefined ? worktreesById.get(record.worktreeId)?.projectId : undefined
    const row: OwnedServerRow = {
      kind: 'owned',
      id: record.id,
      record,
      title: `${OWNER_LABELS[record.ownerKind]} · ${record.ownerId}`,
      detail: [
        command,
        `PID ${record.pid}`,
        record.state === 'running' && startedAt !== undefined
          ? uptimeLabel(startedAt, now)
          : STATE_LABELS[record.state],
        session,
      ]
        .filter((part) => part !== undefined && part !== '')
        .join(' · '),
      command,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(session !== undefined ? { sessionLabel: session } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ports,
      ...(history.length > 0 ? { residentBytes: (history.at(-1) as BytePoint).bytes } : {}),
      ...(cpuPercent !== undefined ? { cpuPercent } : {}),
      history,
      cpuHistory,
      cpuPoints,
      leak: leakState(history, input.alerts),
      ...(record.worktreeId !== undefined ? { worktreeId: record.worktreeId } : {}),
      stoppable: record.state === 'running',
      ...(previewUrl !== undefined ? { previewUrl } : {}),
    }
    const rows =
      record.worktreeId !== undefined
        ? worktreeGroup(record.worktreeId)
        : groupFor('adea', () => ({
            id: 'adea',
            kind: 'adea',
            title: 'Adea',
            subtitle: 'Started by Adea',
          }))
    rows.push(row)
  }

  for (const record of snapshot.foreign ?? []) {
    const history = foreignPoints(record)
    const row: ForeignServerRow = {
      kind: 'foreign',
      id: record.id,
      record,
      title: record.label,
      detail: record.commandPreview ?? record.cwdLabel ?? record.executableIdentity,
      ...(attributionLabel(record) ? { attributionLabel: attributionLabel(record) } : {}),
      ports: record.listeningPorts,
      ...(bytes(record.residentBytes) !== undefined
        ? { residentBytes: bytes(record.residentBytes) }
        : {}),
      ...(record.cpuPercent !== undefined ? { cpuPercent: record.cpuPercent } : {}),
      history,
      leak: leakState(history, input.alerts),
      ...(record.worktreeId !== undefined ? { worktreeId: record.worktreeId } : {}),
      stoppable: record.stoppable,
    }
    if (record.worktreeId !== undefined && worktreesById.has(record.worktreeId)) {
      worktreeGroup(record.worktreeId).push(row)
    } else if (record.protection !== 'none') {
      groupFor('protected', () => ({
        id: 'protected',
        kind: 'protected',
        title: 'Protected',
        subtitle: 'Never stopped from this sheet',
      })).push(row)
    } else {
      groupFor('elsewhere', () => ({
        id: 'elsewhere',
        kind: 'elsewhere',
        title: 'Elsewhere on this machine',
        subtitle: 'Not started by Adea · stopping asks first',
      })).push(row)
    }
  }

  const order: Record<ServerGroup['kind'], number> = {
    worktree: 0,
    missing_worktree: 1,
    adea: 2,
    elsewhere: 3,
    protected: 4,
  }
  const rowWeight = (row: ServerRow) =>
    (row.leak.kind !== 'normal' ? 2 ** 62 : 0) + (row.residentBytes ?? 0)
  return [...groups.values()]
    .map(({ group, rows }) => {
      const sorted = rows.toSorted((left, right) => {
        const ports = Number(right.ports.length > 0) - Number(left.ports.length > 0)
        if (group.kind !== 'worktree' && ports !== 0) return ports
        return rowWeight(right) - rowWeight(left)
      })
      const totalBytes = sum(sorted.map((row) => row.residentBytes))
      return { ...group, ...(totalBytes !== undefined ? { totalBytes } : {}), rows: sorted }
    })
    .toSorted((left, right) => {
      if (order[left.kind] !== order[right.kind]) return order[left.kind] - order[right.kind]
      if (hasLeak(left) !== hasLeak(right)) return hasLeak(left) ? -1 : 1
      return (right.totalBytes ?? 0) - (left.totalBytes ?? 0)
    })
}

export type MemoryBreakdown = Readonly<{
  adeaBytes?: number
  elsewhereBytes?: number
  otherBytes?: number
  freeBytes?: number
  totalBytes?: number
  usedBytes?: number
}>

function hasLeak(group: ServerGroup): boolean {
  return group.rows.some((row) => row.leak.kind !== 'normal')
}

/** Adea's own rows: proven launches and processes started in Adea terminals. */
export function isAdeaRow(row: ServerRow): boolean {
  return row.kind === 'owned' || row.record.attribution.kind === 'adea_terminal'
}

/** Adea (its servers and its terminals' processes), the listed processes
 * elsewhere, other apps, and free memory. Unknown parts stay undefined. */
export function memoryBreakdown(
  groups: readonly ServerGroup[],
  machine: MachineResourceSummary | undefined
): MemoryBreakdown {
  const rows = groups.flatMap((group) => group.rows)
  const adeaBytes = sum(rows.filter(isAdeaRow).map((row) => row.residentBytes))
  const elsewhereBytes = sum(rows.filter((row) => !isAdeaRow(row)).map((row) => row.residentBytes))
  const totalBytes = bytes(machine?.memoryTotalBytes)
  const usedBytes = bytes(machine?.memoryUsedBytes)
  const otherBytes =
    usedBytes !== undefined
      ? Math.max(0, usedBytes - (adeaBytes ?? 0) - (elsewhereBytes ?? 0))
      : undefined
  const freeBytes =
    totalBytes !== undefined && usedBytes !== undefined
      ? Math.max(0, totalBytes - usedBytes)
      : undefined
  return {
    ...(adeaBytes !== undefined ? { adeaBytes } : {}),
    ...(elsewhereBytes !== undefined ? { elsewhereBytes } : {}),
    ...(otherBytes !== undefined ? { otherBytes } : {}),
    ...(freeBytes !== undefined ? { freeBytes } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    ...(usedBytes !== undefined ? { usedBytes } : {}),
  }
}

/** Widths (0–100, summing to at most 100) for a segmented bar. */
export function barSegments(values: readonly (number | undefined)[]): number[] {
  const total = values.reduce<number>((acc, value) => acc + (value ?? 0), 0)
  if (total <= 0) return values.map(() => 0)
  return values.map((value) => ((value ?? 0) / total) * 100)
}

export type StorageRow = Readonly<{
  worktree: Worktree
  title: string
  totalBytes?: number
  sourceBytes?: number
  buildBytes?: number
  state: WorktreeStorageRecord['state'] | 'unknown'
  badges: readonly Readonly<{
    label: string
    tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
  }>[]
}>

const LIFECYCLE_BADGES: Partial<
  Record<
    Worktree['lifecycle'],
    Readonly<{ label: string; tone: StorageRow['badges'][number]['tone'] }>
  >
> = {
  conflicted: { label: 'Conflicted', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'warning' },
  partial: { label: 'Partly cleaned', tone: 'warning' },
  recovery_required: { label: 'Needs recovery', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  quarantined: { label: 'Quarantined', tone: 'neutral' },
  bootstrapping: { label: 'Setting up', tone: 'info' },
}

export function storageRows(
  worktrees: readonly Worktree[],
  records: readonly WorktreeStorageRecord[]
): StorageRow[] {
  const byId = new Map(records.map((record) => [record.worktreeId, record]))
  return worktrees
    .map((worktree) => {
      const record = byId.get(worktree.id)
      const sourceBytes = bytes(record?.sourceBytes)
      const buildBytes = bytes(record?.buildBytes)
      const badges: StorageRow['badges'][number][] = []
      if (worktree.kind === 'primary') badges.push({ label: 'Primary', tone: 'neutral' })
      if (worktree.provenance === 'external') badges.push({ label: 'External', tone: 'neutral' })
      if (worktree.archived) badges.push({ label: 'Archived', tone: 'neutral' })
      const lifecycle = LIFECYCLE_BADGES[worktree.lifecycle]
      if (lifecycle) badges.push(lifecycle)
      const totalBytes = sum([sourceBytes, buildBytes])
      return {
        worktree,
        title: worktreeTitle(worktree),
        ...(totalBytes !== undefined ? { totalBytes } : {}),
        ...(sourceBytes !== undefined ? { sourceBytes } : {}),
        ...(buildBytes !== undefined ? { buildBytes } : {}),
        state: record?.state ?? 'unknown',
        badges,
      } satisfies StorageRow
    })
    .toSorted((left, right) => (right.totalBytes ?? -1) - (left.totalBytes ?? -1))
}

export type StorageTotals = Readonly<{
  sourceBytes?: number
  buildBytes?: number
  retainedBytes?: number
  totalBytes?: number
  /** Some worktree has not finished measuring. */
  partial: boolean
}>

export function storageTotals(
  rows: readonly StorageRow[],
  retained: readonly RetainedDataRecord[]
): StorageTotals {
  const sourceBytes = sum(rows.map((row) => row.sourceBytes))
  const buildBytes = sum(rows.map((row) => row.buildBytes))
  const retainedBytes = sum(retained.map((record) => bytes(record.byteLength)))
  const totalBytes = sum([sourceBytes, buildBytes, retainedBytes])
  return {
    ...(sourceBytes !== undefined ? { sourceBytes } : {}),
    ...(buildBytes !== undefined ? { buildBytes } : {}),
    ...(retainedBytes !== undefined ? { retainedBytes } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    partial: rows.some((row) => row.state !== 'measured'),
  }
}

export type CleanupCandidate =
  | Readonly<{
      kind: 'server'
      id: string
      row: OwnedServerRow
      reason: string
      preselected: boolean
      memoryBytes?: number
    }>
  | Readonly<{
      kind: 'worktree'
      id: string
      worktree: Worktree
      title: string
      reason: string
      preselected: boolean
      diskBytes?: number
    }>
  | Readonly<{
      kind: 'foreign'
      id: string
      row: ForeignServerRow
      reason: string
      /** Processes Adea did not start are never pre-selected. */
      preselected: false
    }>

/** Owned servers idle for the configured time: every CPU sample in the window
 * stayed under 1% and the history covers the whole window. */
function idleFor(row: OwnedServerRow, idleSeconds: number): boolean {
  const first = row.history[0]
  const last = row.history.at(-1)
  if (!first || !last || last.at - first.at < idleSeconds * 1000) return false
  return row.cpuHistory.length > 0 && row.cpuHistory.every((value) => value < 1)
}

export function cleanupCandidates(input: {
  groups: readonly ServerGroup[]
  worktrees: readonly Worktree[]
  storage: readonly StorageRow[]
  preferences: ResourcePreferencesInput
}): CleanupCandidate[] {
  const candidates: CleanupCandidate[] = []
  for (const group of input.groups) {
    for (const row of group.rows) {
      if (row.kind === 'owned') {
        if (!row.stoppable) continue
        if (group.kind === 'missing_worktree') {
          candidates.push({
            kind: 'server',
            id: row.id,
            row,
            reason: 'Its worktree was deleted',
            preselected: row.leak.kind === 'normal',
            ...(row.residentBytes !== undefined ? { memoryBytes: row.residentBytes } : {}),
          })
        } else if (idleFor(row, input.preferences.cleanup.serverIdleSeconds)) {
          candidates.push({
            kind: 'server',
            id: row.id,
            row,
            reason: 'Idle',
            preselected: row.leak.kind === 'normal',
            ...(row.residentBytes !== undefined ? { memoryBytes: row.residentBytes } : {}),
          })
        }
      } else if (row.stoppable && (row.ports.length > 0 || row.leak.kind !== 'normal')) {
        candidates.push({
          kind: 'foreign',
          id: row.id,
          row,
          reason: row.leak.kind !== 'normal' ? 'Using a lot of memory' : 'Holding a port',
          preselected: false,
        })
      }
    }
  }
  const storageById = new Map(input.storage.map((row) => [row.worktree.id, row]))
  for (const worktree of input.worktrees) {
    if (worktree.kind !== 'managed' || worktree.provenance !== 'adea' || !worktree.archived)
      continue
    const storage = storageById.get(worktree.id)
    candidates.push({
      kind: 'worktree',
      id: worktree.id,
      worktree,
      title: worktreeTitle(worktree),
      reason: 'Archived',
      preselected: true,
      ...(storage?.totalBytes !== undefined ? { diskBytes: storage.totalBytes } : {}),
    })
  }
  return candidates
}

/** The banner: how many things clean-up would act on by default. */
export function attentionSummary(
  candidates: readonly CleanupCandidate[],
  groups: readonly ServerGroup[]
) {
  const preselected = candidates.filter((candidate) => candidate.preselected)
  const diskBytes = sum(
    preselected.map((candidate) =>
      candidate.kind === 'worktree' ? candidate.diskBytes : undefined
    )
  )
  const leaking = groups.flatMap((group) => group.rows).filter((row) => row.leak.kind !== 'normal')
  return {
    count: preselected.length,
    ...(diskBytes !== undefined ? { diskBytes } : {}),
    leaking,
    foreignCount: candidates.filter((candidate) => candidate.kind === 'foreign').length,
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Every kind of issue the banner names, most urgent first: leaking and
 * over-limit rows (Adea's or not), then the clean-up candidates by reason. A
 * foreign row that is a candidate because of its memory is already counted
 * as leaking or over the limit. */
export function attentionIssues(
  candidates: readonly CleanupCandidate[],
  groups: readonly ServerGroup[]
): string[] {
  const rows = groups.flatMap((group) => group.rows)
  const growing = rows.filter((row) => row.leak.kind === 'growing').length
  const overLimit = rows.filter((row) => row.leak.kind === 'over_limit').length
  const count = (test: (candidate: CleanupCandidate) => boolean) => candidates.filter(test).length
  const orphaned = count(
    (candidate) => candidate.kind === 'server' && candidate.reason === 'Its worktree was deleted'
  )
  const idle = count((candidate) => candidate.kind === 'server' && candidate.reason === 'Idle')
  const archived = count((candidate) => candidate.kind === 'worktree')
  const holdingPorts = count(
    (candidate) => candidate.kind === 'foreign' && candidate.reason === 'Holding a port'
  )
  const issues: string[] = []
  if (growing > 0) issues.push(`${plural(growing, 'server', 'servers')} leaking memory`)
  if (overLimit > 0) issues.push(`${plural(overLimit, 'server', 'servers')} over your memory limit`)
  if (orphaned > 0)
    issues.push(`${plural(orphaned, 'server', 'servers')} whose worktree was deleted`)
  if (idle > 0) issues.push(plural(idle, 'idle server', 'idle servers'))
  if (archived > 0) issues.push(plural(archived, 'archived worktree', 'archived worktrees'))
  if (holdingPorts > 0)
    issues.push(
      `${plural(holdingPorts, 'process', 'processes')} not started by Adea holding ${holdingPorts === 1 ? 'a port' : 'ports'}`
    )
  return issues
}
