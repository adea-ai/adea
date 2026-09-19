// Per-project dependency-template cache.
//
// One immutable dependency tree per project, populated by an approved
// bootstrap-class install into a template directory under the project's
// approved data location — never inside a worktree or the primary checkout,
// and never mutated in place after promotion. A new worktree whose validity
// digest (lockfile + manifest + package manager + relevant config) matches the
// promoted template materializes its dependencies via CoW file clones and
// skips the install; a miss or stale digest falls back to normal bootstrap and
// may promote a fresh template. Promotion is an approved, locked (one build at
// a time per project), audited operation. Templates appear in #424's
// retained-data breakdown and as cleanup candidates.
//
// Safety mirrors the include-copy rules: per-file clones with
// `COPYFILE_FICLONE | COPYFILE_EXCL` (never stream loops, never bulk directory
// clones), per-file identity and containment rechecks, and no custom ACLs.
import {
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, sep } from 'node:path'

import { nowIso, newRecordId, sameScope, type DevScope } from '../authority'
import { createDurableJsonStore } from '../host-store'
import { WorktreeError } from './errors'
import { identityOfPath, sameIdentity, type FileIdentityValue } from './identity'

export const TEMPLATE_MAX_FILES = 250_000
export const TEMPLATE_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
export const TEMPLATE_SCAN_MAX_ENTRIES = 1_000_000

export type TemplateState = 'building' | 'ready' | 'stale' | 'failed'

export type TemplateValidityComponents = Readonly<{
  packageManager: string
  lockfiles: Readonly<Record<string, string>>
  manifests: Readonly<Record<string, string>>
  configDigests: Readonly<Record<string, string>>
}>

export type TemplateRecord = Readonly<{
  id: string
  scope: DevScope
  projectId: string
  validityDigest: string
  components: TemplateValidityComponents
  state: TemplateState
  /** Content digest over the promoted file set; materialization re-proves it. */
  contentDigest?: string
  /** Cheap stat-manifest fingerprint (paths+sizes+mtimes) for materialize-time tamper checks. */
  statDigest?: string
  fileCount?: number
  totalBytes?: number
  templatePath?: string
  error?: string
  createdAt: string
  promotedAt?: string
}>

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Deterministic validity digest over the package-manager identity, lockfiles,
 *  manifests, and relevant config hashes. */
export function computeValidityDigest(components: TemplateValidityComponents): string {
  const canonical = {
    packageManager: components.packageManager,
    lockfiles: sortedEntries(components.lockfiles),
    manifests: sortedEntries(components.manifests),
    configDigests: sortedEntries(components.configDigests),
  }
  return sha256(JSON.stringify(canonical))
}

function sortedEntries(record: Readonly<Record<string, string>>): Array<[string, string]> {
  return Object.entries(record)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

function statManifestDigest(
  files: Array<{ relativePath: string; size: number; mtimeMs: number }>
): string {
  // Pure stat fingerprint: the entries were statted during the template scan,
  // so this adds zero I/O. Catches post-promotion edits without re-reading.
  const hasher = new Bun.CryptoHasher('sha256')
  for (const file of files) {
    hasher.update(JSON.stringify([file.relativePath, file.size, file.mtimeMs]))
  }
  return hasher.digest('hex')
}

async function hashFile(path: string): Promise<string> {
  const file = Bun.file(path)
  const hasher = new Bun.CryptoHasher('sha256')
  const stream = file.stream()
  for await (const chunk of stream) hasher.update(chunk)
  return hasher.digest('hex')
}

/** List every file under a directory via Bun.Glob with hard entry/byte
 *  budgets. Returns relative paths sorted for a stable content digest. */
async function listTemplateFiles(
  templateRoot: string,
  budgets: { maxFiles: number; maxTotalBytes: number; maxEntries: number }
): Promise<Array<{ relativePath: string; size: number; mtimeMs: number }>> {
  const glob = new Bun.Glob('**/*')
  const files: Array<{ relativePath: string; size: number }> = []
  let entries = 0
  let totalBytes = 0
  for await (const entry of glob.scan({ cwd: templateRoot, onlyFiles: true, dot: true })) {
    entries += 1
    if (entries > budgets.maxEntries) {
      throw new WorktreeError('limit_exceeded', 'template scan exceeded the entry budget')
    }
    const absolute = join(templateRoot, entry)
    const stat = lstatSync(absolute, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue
    totalBytes += stat.size
    if (totalBytes > budgets.maxTotalBytes) {
      throw new WorktreeError('limit_exceeded', 'template exceeded the byte budget')
    }
    files.push({ relativePath: entry, size: stat.size, mtimeMs: stat.mtimeMs })
    if (files.length > budgets.maxFiles) {
      throw new WorktreeError('limit_exceeded', 'template exceeded the file budget')
    }
  }
  return files.toSorted((a, b) => (a.relativePath < b.relativePath ? -1 : 1))
}

export type TemplateBuildHandle = {
  stagingDir: string
  commit: (input?: { logTail?: string }) => Promise<TemplateRecord>
  abort: (reason: string) => Promise<TemplateRecord>
}

function findRecord(
  records: TemplateRecord[],
  scope: DevScope,
  projectId: string
): TemplateRecord | undefined {
  const record = records.find((entry) => entry.projectId === projectId)
  if (!record || !sameScope(record.scope, scope)) return undefined
  return record
}

export type TemplateCache = ReturnType<typeof createTemplateCache>

export function createTemplateCache(options: { dataDir: string; clock?: () => Date }) {
  const { dataDir, clock = () => new Date() } = options
  const root = join(dataDir, 'dev-runtime', 'worktrees', 'templates')
  const store = createDurableJsonStore<TemplateRecord>({
    file: join(root, 'records.json'),
    schemaVersion: 1,
    label: 'dependency template',
  })
  mkdirSync(root, { recursive: true, mode: 0o700 })

  function loadRecords(): TemplateRecord[] {
    return [...store.load().records]
  }

  function persist(records: TemplateRecord[]): void {
    store.save(records)
  }

  function projectDir(projectId: string): string {
    return join(root, sha256(projectId).slice(0, 16))
  }

  function status(scope: DevScope, projectId: string): TemplateRecord | { state: 'absent' } {
    const record = findRecord(loadRecords(), scope, projectId)
    return record ?? { state: 'absent' }
  }

  /** Begin one approved build. Only one build may run per project at a time:
   *  a live `building` record (or an existing staging dir) refuses. The build
   *  populates the returned staging directory; `commit` promotes it. */
  async function beginBuild(input: {
    scope: DevScope
    projectId: string
    components: TemplateValidityComponents
    approval: { method: string; reference: string }
  }): Promise<TemplateBuildHandle> {
    if (
      !input.approval.method ||
      !input.approval.reference ||
      input.approval.reference.length < 1 ||
      input.approval.reference.length > 256
    ) {
      throw new WorktreeError('unauthorized', 'template build requires owner approval evidence')
    }
    const records = loadRecords()
    const existing = findRecord(records, input.scope, input.projectId)
    if (existing && existing.state === 'building') {
      throw new WorktreeError(
        'invalid_state',
        'a template build is already in progress for this project'
      )
    }
    const dir = projectDir(input.projectId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stagingDir = join(dir, `staging-${Date.now()}-${newRecordId().slice(0, 8)}`)
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 })

    const record: TemplateRecord = {
      id: newRecordId(),
      scope: { ...input.scope },
      projectId: input.projectId,
      validityDigest: computeValidityDigest(input.components),
      components: input.components,
      state: 'building',
      createdAt: nowIso(clock),
    }
    const next = records.filter(
      (entry) => entry.projectId !== input.projectId || !sameScope(entry.scope, input.scope)
    )
    next.push(record)
    persist(next)

    let committed = false
    return {
      stagingDir,
      async commit(): Promise<TemplateRecord> {
        if (committed) throw new WorktreeError('invalid_state', 'template build already settled')
        committed = true
        const files = await listTemplateFiles(stagingDir, {
          maxFiles: TEMPLATE_MAX_FILES,
          maxTotalBytes: TEMPLATE_MAX_TOTAL_BYTES,
          maxEntries: TEMPLATE_SCAN_MAX_ENTRIES,
        })
        const hasher = new Bun.CryptoHasher('sha256')
        hasher.update(JSON.stringify(files.map((file) => [file.relativePath, file.size])))
        for (const file of files) {
          hasher.update(await hashFile(join(stagingDir, file.relativePath)))
        }
        const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
        const readyDir = join(dir, 'ready')
        // Promote by rename: the staging content becomes the immutable ready
        // tree atomically; a previous ready tree is replaced, never edited.
        rmSync(readyDir, { force: true, recursive: true })
        try {
          renameSync(stagingDir, readyDir)
        } catch {
          rmSync(stagingDir, { force: true, recursive: true })
          throw new WorktreeError('invalid_state', 'template promotion rename failed')
        }
        const promoted: TemplateRecord = {
          ...record,
          state: 'ready',
          contentDigest: hasher.digest('hex'),
          statDigest: statManifestDigest(files),
          fileCount: files.length,
          totalBytes,
          templatePath: readyDir,
          promotedAt: nowIso(clock),
        }
        const all = loadRecords()
        const promotedRecords = all.filter(
          (entry) => entry.projectId !== input.projectId || !sameScope(entry.scope, input.scope)
        )
        promotedRecords.push(promoted)
        persist(promotedRecords)
        return promoted
      },
      async abort(reason: string): Promise<TemplateRecord> {
        if (committed) throw new WorktreeError('invalid_state', 'template build already settled')
        committed = true
        rmSync(stagingDir, { force: true, recursive: true })
        const failed: TemplateRecord = {
          ...record,
          state: 'failed',
          error: reason.slice(0, 512),
        }
        const all = loadRecords()
        const failedRecords = all.filter(
          (entry) => entry.projectId !== input.projectId || !sameScope(entry.scope, input.scope)
        )
        failedRecords.push(failed)
        persist(failedRecords)
        return failed
      },
    }
  }

  /** Materialize a ready template into a fresh worktree via CoW file clones.
   *  The destination must still be the directory the caller proved (its
   *  identity is rechecked), every destination path is re-proven absent, and
   *  every clone lands inside the destination root. */
  async function materialize(input: {
    scope: DevScope
    projectId: string
    validityDigest: string
    worktreeRoot: string
    worktreeIdentity: FileIdentityValue
    budgets?: { maxFiles?: number; maxTotalBytes?: number }
  }): Promise<{ copied: number; totalBytes: number; contentDigest: string }> {
    const record = findRecord(loadRecords(), input.scope, input.projectId)
    if (!record || record.state !== 'ready' || !record.templatePath || !record.contentDigest) {
      throw new WorktreeError(
        'invalid_state',
        'no ready dependency template exists for this project'
      )
    }
    if (record.validityDigest !== input.validityDigest) {
      throw new WorktreeError(
        'plan_stale',
        'dependency template digest does not match this worktree'
      )
    }
    const freshRoot = identityOfPath(input.worktreeRoot)
    if (!sameIdentity(freshRoot, input.worktreeIdentity)) {
      throw new WorktreeError(
        'identity_mismatch',
        'worktree root changed before template materialization'
      )
    }
    const templateRoot = realpathSync(record.templatePath)
    const destinationRoot = realpathSync(input.worktreeRoot)

    const files = await listTemplateFiles(templateRoot, {
      maxFiles: input.budgets?.maxFiles ?? TEMPLATE_MAX_FILES,
      maxTotalBytes: input.budgets?.maxTotalBytes ?? TEMPLATE_MAX_TOTAL_BYTES,
      maxEntries: TEMPLATE_SCAN_MAX_ENTRIES,
    })
    // Tamper check without re-reading content: the full content hash was
    // proven once at promotion and the ready tree is immutable after rename,
    // so a cheap stat-manifest fingerprint detects post-promotion changes.
    const statDigest = statManifestDigest(files)
    if (record.statDigest && statDigest !== record.statDigest) {
      throw new WorktreeError(
        'identity_mismatch',
        'dependency template content changed after promotion'
      )
    }

    let copied = 0
    const verifiedParents = new Map<string, { dev: number; ino: number }>()
    for (const file of files) {
      const source = join(templateRoot, file.relativePath)
      const destination = join(destinationRoot, file.relativePath)
      const sourceStat = lstatSync(source, { throwIfNoEntry: false })
      if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new WorktreeError(
          'special_file_rejected',
          `template file is not a regular file: ${file.relativePath}`
        )
      }
      if (lstatSync(destination, { throwIfNoEntry: false })) {
        throw new WorktreeError('file_changed', `template destination exists: ${file.relativePath}`)
      }
      const destinationParent = dirname(destination)
      const verified = verifiedParents.get(destinationParent)
      if (verified) {
        const current = lstatSync(destinationParent, { throwIfNoEntry: false })
        if (!current || current.dev !== verified.dev || current.ino !== verified.ino) {
          throw new WorktreeError(
            'path_escape',
            `template destination parent changed during materialization: \${file.relativePath}`
          )
        }
      } else {
        mkdirSync(destinationParent, { recursive: true, mode: 0o755 })
        const parentReal = realpathSync(destinationParent)
        if (parentReal !== destinationRoot && !parentReal.startsWith(destinationRoot + sep)) {
          throw new WorktreeError(
            'path_escape',
            `template destination escapes the worktree: \${file.relativePath}`
          )
        }
        const parentStats = lstatSync(destinationParent)
        verifiedParents.set(destinationParent, { dev: parentStats.dev, ino: parentStats.ino })
      }
      copyFileSync(source, destination, fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL)
      copied += 1
    }
    return { copied, totalBytes: record.totalBytes ?? 0, contentDigest: record.contentDigest }
  }

  /** Remove the template. Never touches worktrees or the primary checkout:
   *  only the cache directory and record are removed. */
  function clear(scope: DevScope, projectId: string): { cleared: boolean } {
    const records = loadRecords()
    const record = findRecord(records, scope, projectId)
    if (!record) return { cleared: false }
    if (record.state === 'building') {
      throw new WorktreeError(
        'invalid_state',
        'cannot clear a project template while a build is in progress'
      )
    }
    const dir = projectDir(projectId)
    rmSync(dir, { force: true, recursive: true })
    persist(records.filter((entry) => entry.id !== record.id))
    return { cleared: true }
  }

  return Object.freeze({
    status,
    beginBuild,
    materialize,
    clear,
    computeValidityDigest,
  })
}
