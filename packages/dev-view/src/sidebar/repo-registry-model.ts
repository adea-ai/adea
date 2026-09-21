import type {
  CredentialRef,
  DevError,
  Project,
  ProjectRepoBinding,
  Repo,
  RepoInspection,
  RootBookmark,
} from '@adea-ai/types/dev-runtime'

/**
 * Pure model for the sidebar repository registry surface (#398 follow-up).
 * The Dev View owns no registry authority: it renders the project bindings an
 * import minted (`Project.repos`) joined with the durable `Repo` records the
 * runtime register serves, and every mutation is one `dev.repo.*` /
 * `dev.project.archive` command over the authenticated command path. Secret
 * material never appears here — `CredentialRef` carries only its id, label,
 * host, and state, and `Repo.remote` is the redacted remote DTO.
 *
 * Project archive rides the same explicit confirmation gate the archive shelf
 * uses (request → confirm/cancel) and a refusal (live sessions, stale
 * version) surfaces as a typed non-blocking notice, never a fabricated
 * success.
 */

/** One project that names a repo binding. */
export type RepoProjectRef = Readonly<{
  id: string
  name: string
  archived: boolean
  version: number
}>

/** One repo binding joined across the projects that name it. */
export type RepoBindingView = Readonly<{
  repoId: string
  canonicalRoot: string
  /** The bookmark the import authorized; the adopt default. */
  rootBookmarkId: string
  projects: readonly RepoProjectRef[]
}>

export type RepoRowLifecycle = Repo['lifecycle'] | 'binding-only'

export type RepoRegistryRow = Readonly<{
  repoId: string
  canonicalRoot: string
  rootBookmarkId: string
  projects: readonly RepoProjectRef[]
  /** The durable registry record, when the repo has been adopted. */
  record?: Repo
  /** The latest strict `dev.repo.inspect` facts rendered for this row. */
  inspection?: RepoInspection
  lifecycle: RepoRowLifecycle
}>

export type RepoRegistryState = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  rows: readonly RepoRegistryRow[]
  /** Projects offered the archive confirm gate, in registry order. */
  projects: readonly Project[]
  /** The project awaiting archive confirmation, if any. */
  pendingArchiveProjectId?: string
  reason?: string
}>

export function beginRegistryLoad(): RepoRegistryState {
  return { status: 'loading', rows: [], projects: [] }
}

export function registryReady(
  rows: readonly RepoRegistryRow[],
  projects: readonly Project[]
): RepoRegistryState {
  return { status: 'ready', rows, projects }
}

export function registryUnavailable(reason: string): RepoRegistryState {
  return { status: 'unavailable', rows: [], projects: [], reason }
}

/** Provider loss keeps recoverable rows mounted; the state names the error. */
export function registryError(reason: string, previous: RepoRegistryState): RepoRegistryState {
  return { ...previous, status: 'error', reason }
}

const projectRefOf = (project: Project): RepoProjectRef => ({
  id: project.id,
  name: project.name,
  archived: project.lifecycle === 'archived',
  version: project.version,
})

/** Flatten the `Project.repos` binding triples (#398) into repo views. */
export function projectBindings(projects: readonly Project[]): readonly RepoBindingView[] {
  const byRepo = new Map<string, { binding: ProjectRepoBinding; projects: RepoProjectRef[] }>()
  for (const project of projects) {
    for (const binding of project.repos ?? []) {
      const existing = byRepo.get(binding.repoId)
      if (existing) existing.projects.push(projectRefOf(project))
      else byRepo.set(binding.repoId, { binding, projects: [projectRefOf(project)] })
    }
  }
  return [...byRepo.values()].map(({ binding, projects: named }) => ({
    repoId: binding.repoId,
    canonicalRoot: binding.canonicalRoot,
    rootBookmarkId: binding.rootBookmarkId,
    projects: named,
  }))
}

/** The basename of a canonical root, for row titles. */
export function repoBaseName(canonicalRoot: string): string {
  const trimmed = canonicalRoot.replace(/\/+$/, '')
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return last.length > 0 ? last : trimmed
}

/** Join bindings with the durable records the register serves. Records
 *  without a binding still render (adopted, then unbound); rows sort by first
 *  project name, then canonical root. */
export function repoRows(
  bindings: readonly RepoBindingView[],
  records: readonly Repo[]
): readonly RepoRegistryRow[] {
  const rows: RepoRegistryRow[] = []
  const recordByRepo = new Map(records.map((record) => [record.id, record]))
  for (const binding of bindings) {
    const record = recordByRepo.get(binding.repoId)
    rows.push({
      repoId: binding.repoId,
      canonicalRoot: record?.canonicalRoot ?? binding.canonicalRoot,
      rootBookmarkId: binding.rootBookmarkId,
      projects: [...binding.projects],
      ...(record ? { record } : {}),
      lifecycle: record?.lifecycle ?? 'binding-only',
    })
  }
  const bound = new Set(bindings.map((binding) => binding.repoId))
  for (const record of records) {
    if (bound.has(record.id)) continue
    rows.push({
      repoId: record.id,
      canonicalRoot: record.canonicalRoot,
      rootBookmarkId: '',
      projects: [],
      record,
      lifecycle: record.lifecycle,
    })
  }
  return rows.toSorted((left, right) => {
    const leftName = left.projects[0]?.name ?? repoBaseName(left.canonicalRoot)
    const rightName = right.projects[0]?.name ?? repoBaseName(right.canonicalRoot)
    return (
      leftName.localeCompare(rightName) || left.canonicalRoot.localeCompare(right.canonicalRoot)
    )
  })
}

/** The version a repo command binds: an unadopted binding starts at 1 (the
 *  initial version every registry record carries), an adopted row re-proofs
 *  at its record version. */
export function expectedRepoVersion(row: Pick<RepoRegistryRow, 'record'>): number {
  return row.record?.version ?? 1
}

/** Default adopt bookmark: the binding's own authorized bookmark when it is
 *  still active; otherwise the first active repository bookmark. Stale or
 *  revoked bookmarks are never defaults. Returns '' when nothing qualifies. */
export function defaultAdoptBookmarkId(
  row: Pick<RepoRegistryRow, 'rootBookmarkId'>,
  bookmarks: readonly RootBookmark[]
): string {
  const binding = bookmarks.find(
    (bookmark) =>
      bookmark.id === row.rootBookmarkId &&
      bookmark.state === 'active' &&
      bookmark.kind === 'repository'
  )
  if (binding) return binding.id
  const firstActive = bookmarks.find(
    (bookmark) => bookmark.state === 'active' && bookmark.kind === 'repository'
  )
  return firstActive?.id ?? ''
}

/** Ready credential refs whose host matches the repo's remote host
 *  (case-insensitive — the same comparison the register proves). */
export function credentialRefsForHost(
  refs: readonly CredentialRef[],
  host: string
): readonly CredentialRef[] {
  const wanted = host.toLowerCase()
  return refs.filter((ref) => ref.state === 'ready' && ref.host.toLowerCase() === wanted)
}

/** One-line inspection summary: head ref, short SHA, dirty marker. */
export function inspectionLine(inspection: RepoInspection): string {
  if (inspection.repo.lifecycle === 'unavailable') return 'Checkout unavailable'
  const sha = inspection.headSha === undefined ? '' : inspection.headSha.slice(0, 7)
  const refPart = inspection.headRef ?? 'detached HEAD'
  const shaPart = sha === '' ? '' : ` @ ${sha}`
  return `${refPart}${shaPart}${inspection.dirty ? ' · dirty' : ' · clean'}`
}

export function lifecycleBadge(lifecycle: RepoRowLifecycle): {
  label: string
  tone: 'success' | 'failure' | 'progress' | undefined
} {
  switch (lifecycle) {
    case 'ready':
      return { label: 'ready', tone: 'success' }
    case 'stale':
    case 'unavailable':
      return { label: lifecycle, tone: 'failure' }
    case 'authorizing':
    case 'refreshing':
      return { label: lifecycle, tone: 'progress' }
    case 'binding-only':
      return { label: 'not adopted', tone: undefined }
  }
}

/**
 * Typed-unavailable copy: the registry operations live behind the M10 gate,
 * so a runtime without the provider answers `capability_unavailable` — the
 * panel says exactly that instead of rendering a dead control set.
 */
export function registryUnavailableNotice(code: string): string {
  if (code === 'capability_unavailable')
    return 'The repository registry is not available on this runtime (capability_unavailable).'
  if (code === 'capability_denied')
    return 'This workspace is not permitted repository registry access (capability_denied).'
  if (code === 'unauthenticated' || code === 'channel_unauthenticated')
    return 'The runtime channel is not authenticated; repositories are unavailable.'
  return `Repositories are unavailable (${code}).`
}

/** Non-blocking notice copy for a refused adopt/authorize/refresh. */
export function repoCommandNotice(operation: string, error: DevError): string {
  if (error.code === 'stale_version')
    return `${operation} was refused: the repository moved on. The view reloaded — try again.`
  if (error.code === 'unauthorized_root')
    return `${operation} was refused: the authorized root does not cover this checkout.`
  if (error.code === 'identity_mismatch')
    return `${operation} was refused: the credential host does not match the repository remote host.`
  return `${operation} was refused: ${error.message}`
}

/** Non-blocking notice copy for a refused project archive/unarchive. */
export function archiveNoticeForError(error: DevError): string {
  if (error.code === 'invalid_state')
    // The register refuses while live sessions exist; the message names them.
    return `Archive was refused: ${error.message}`
  if (error.code === 'stale_version')
    return 'Archive was refused: the project moved on. The view reloaded — try again.'
  if (error.code === 'capability_unavailable')
    return 'Project archive is not available on this runtime (capability_unavailable).'
  return `Archive was refused: ${error.message}`
}

export function requestArchive(state: RepoRegistryState, projectId: string): RepoRegistryState {
  return { ...state, pendingArchiveProjectId: projectId }
}

export function cancelPendingArchive(state: RepoRegistryState): RepoRegistryState {
  return state.pendingArchiveProjectId === undefined
    ? state
    : { ...state, pendingArchiveProjectId: undefined }
}

export function confirmPendingArchive(state: RepoRegistryState): {
  state: RepoRegistryState
  projectId?: string
} {
  if (state.pendingArchiveProjectId === undefined) return { state }
  const projectId = state.pendingArchiveProjectId
  return { state: { ...state, pendingArchiveProjectId: undefined }, projectId }
}
