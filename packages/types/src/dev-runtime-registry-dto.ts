import type {
  CredentialRef,
  Project,
  Repo,
  RepoInspection,
  RootBookmark,
  Worktree,
} from './dev-runtime'
import {
  decodeScope,
  exactKeys,
  fail,
  gitShaPattern,
  integerValue,
  literal,
  record,
  sha256Pattern,
  stringValue,
  timestamp,
  uuidPattern,
} from './dev-runtime-validation-internal'

/** Every worktree lifecycle state (spec "State machines › Worktree"). */
export const worktreeLifecycles = [
  'discovered',
  'authorizing',
  'creating',
  'bootstrapping',
  'ready',
  'archived',
  'merging',
  'conflicted',
  'cleanup_planned',
  'quiescing',
  'teardown',
  'quarantined',
  'unregistered',
  'deleting',
  'branch_cleanup',
  'cleaned',
  'blocked',
  'partial',
  'recovery_required',
  'failed',
] as const

function stringArray(value: unknown, path: string, maxLength: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected array')
  if (value.length > maxLength) fail(path, `array exceeds ${maxLength}`)
  value.forEach((entry, index) => stringValue(entry, `${path}[${index}]`))
  return value
}

/** Strict registry DTO validators shared by the full server contract and lazy client views. */
export function decodeRegistryDto(name: string, value: unknown, path: string): unknown {
  if (name === 'FileIdentity') {
    const item = record(value, path)
    exactKeys(item, ['mtimeNs', 'size'], ['device', 'inode', 'birthtimeNs', 'contentSha256'], path)
    for (const key of ['mtimeNs', 'size', 'device', 'inode', 'birthtimeNs'] as const)
      if (item[key] !== undefined) stringValue(item[key], `${path}.${key}`)
    if (
      item.contentSha256 !== undefined &&
      !sha256Pattern.test(stringValue(item.contentSha256, `${path}.contentSha256`))
    )
      fail(`${path}.contentSha256`, 'expected sha256')
    return value
  }
  if (name === 'RootBookmark') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'label',
        'kind',
        'canonicalRoot',
        'rootIdentity',
        'state',
        'generation',
        'version',
      ],
      [],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.label, `${path}.label`, 1, 128)
    literal(item.kind, ['directory', 'repository'], `${path}.kind`)
    const canonicalRoot = stringValue(item.canonicalRoot, `${path}.canonicalRoot`, 1, 4096)
    if (canonicalRoot.includes('\0')) fail(`${path}.canonicalRoot`, 'expected path without NUL')
    decodeRegistryDto('FileIdentity', item.rootIdentity, `${path}.rootIdentity`)
    literal(item.state, ['active', 'stale', 'revoked'], `${path}.state`)
    integerValue(item.generation, `${path}.generation`, 0)
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'CredentialRef') {
    const item = record(value, path)
    exactKeys(item, ['id', 'scope', 'label', 'host', 'kind', 'state', 'version'], [], path)
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.label, `${path}.label`, 1, 128)
    stringValue(item.host, `${path}.host`, 1, 253)
    literal(item.kind, ['git_https', 'github_token', 'ssh_key', 'other'], `${path}.kind`)
    literal(item.state, ['ready', 'expired', 'revoked', 'unknown'], `${path}.state`)
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'Project') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'scope', 'repoIds', 'lifecycle', 'version'],
      [
        'repos',
        'preferredRuntimeNodeId',
        'defaultBaseRef',
        'bootstrapWorkflowId',
        'defaultHarnessId',
      ],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringArray(item.repoIds, `${path}.repoIds`, 128)
    if (item.repos !== undefined) {
      if (!Array.isArray(item.repos)) fail(`${path}.repos`, 'expected array')
      if ((item.repos as unknown[]).length > 128) fail(`${path}.repos`, 'array exceeds 128')
      ;(item.repos as unknown[]).forEach((entry, index) =>
        decodeRegistryDto('ProjectRepoBinding', entry, `${path}.repos[${index}]`)
      )
    }
    if (item.preferredRuntimeNodeId !== undefined)
      stringValue(item.preferredRuntimeNodeId, `${path}.preferredRuntimeNodeId`, 1, 256)
    if (item.defaultBaseRef !== undefined)
      stringValue(item.defaultBaseRef, `${path}.defaultBaseRef`, 1, 256)
    if (item.bootstrapWorkflowId !== undefined)
      stringValue(item.bootstrapWorkflowId, `${path}.bootstrapWorkflowId`, 1, 256)
    if (item.defaultHarnessId !== undefined)
      stringValue(item.defaultHarnessId, `${path}.defaultHarnessId`, 1, 256)
    literal(
      item.lifecycle,
      ['importing', 'cloning', 'scanning', 'ready', 'archived', 'failed'],
      `${path}.lifecycle`
    )
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'ProjectRepoBinding') {
    const item = record(value, path)
    exactKeys(item, ['repoId', 'rootBookmarkId', 'canonicalRoot'], [], path)
    if (!uuidPattern.test(stringValue(item.repoId, `${path}.repoId`)))
      fail(`${path}.repoId`, 'expected lowercase UUID')
    if (!uuidPattern.test(stringValue(item.rootBookmarkId, `${path}.rootBookmarkId`)))
      fail(`${path}.rootBookmarkId`, 'expected lowercase UUID')
    stringValue(item.canonicalRoot, `${path}.canonicalRoot`, 1, 4096)
    return value
  }
  if (name === 'RedactedRemote') {
    const item = record(value, path)
    exactKeys(item, ['provider', 'host', 'ownerPath', 'displayUrl'], [], path)
    literal(item.provider, ['github', 'gitlab', 'other'], `${path}.provider`)
    stringValue(item.host, `${path}.host`, 1, 253)
    stringValue(item.ownerPath, `${path}.ownerPath`, 0, 1024)
    stringValue(item.displayUrl, `${path}.displayUrl`, 0, 2048)
    return value
  }
  if (name === 'Repo') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'scope', 'kind', 'lifecycle', 'canonicalRoot', 'projectIds', 'version'],
      ['gitCommonDirIdentity', 'remote', 'defaultRef'],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    literal(item.kind, ['git', 'folder'], `${path}.kind`)
    literal(
      item.lifecycle,
      ['authorizing', 'ready', 'unavailable', 'stale', 'refreshing'],
      `${path}.lifecycle`
    )
    const canonicalRoot = stringValue(item.canonicalRoot, `${path}.canonicalRoot`, 1, 4096)
    if (canonicalRoot.includes('\0')) fail(`${path}.canonicalRoot`, 'expected path without NUL')
    if (item.gitCommonDirIdentity !== undefined)
      decodeRegistryDto('FileIdentity', item.gitCommonDirIdentity, `${path}.gitCommonDirIdentity`)
    if (item.remote !== undefined)
      decodeRegistryDto('RedactedRemote', item.remote, `${path}.remote`)
    if (item.defaultRef !== undefined) stringValue(item.defaultRef, `${path}.defaultRef`, 1, 256)
    stringArray(item.projectIds, `${path}.projectIds`, 128)
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'RepoInspection') {
    const item = record(value, path)
    exactKeys(item, ['repo', 'rootIdentity', 'dirty', 'observedAt'], ['headRef', 'headSha'], path)
    decodeRegistryDto('Repo', item.repo, `${path}.repo`)
    decodeRegistryDto('FileIdentity', item.rootIdentity, `${path}.rootIdentity`)
    if (item.headRef !== undefined) stringValue(item.headRef, `${path}.headRef`, 1, 256)
    if (item.headSha !== undefined) {
      if (!gitShaPattern.test(stringValue(item.headSha, `${path}.headSha`)))
        fail(`${path}.headSha`, 'expected git sha')
    }
    if (typeof item.dirty !== 'boolean') fail(`${path}.dirty`, 'expected boolean')
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'Worktree') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'kind',
        'repoId',
        'projectId',
        'canonicalRoot',
        'rootIdentity',
        'provenance',
        'lifecycle',
        'bootstrap',
        'archived',
        'generation',
        'version',
      ],
      ['branchRef', 'title', 'taskId', 'baseRef', 'baseSha', 'headRef', 'headSha'],
      path
    )
    for (const key of ['id', 'repoId', 'projectId'] as const)
      if (!uuidPattern.test(stringValue(item[key], `${path}.${key}`)))
        fail(`${path}.${key}`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    literal(item.kind, ['primary', 'managed', 'external'], `${path}.kind`)
    const canonicalRoot = stringValue(item.canonicalRoot, `${path}.canonicalRoot`, 1, 4096)
    if (canonicalRoot.includes('\0')) fail(`${path}.canonicalRoot`, 'expected path without NUL')
    decodeRegistryDto('FileIdentity', item.rootIdentity, `${path}.rootIdentity`)
    literal(item.provenance, ['adea', 'external'], `${path}.provenance`)
    for (const key of ['branchRef', 'baseRef', 'headRef'] as const)
      if (item[key] !== undefined) stringValue(item[key], `${path}.${key}`, 1, 256)
    if (item.title !== undefined) stringValue(item.title, `${path}.title`, 1, 120)
    if (item.taskId !== undefined) stringValue(item.taskId, `${path}.taskId`, 1, 256)
    for (const key of ['baseSha', 'headSha'] as const)
      if (item[key] !== undefined && !gitShaPattern.test(stringValue(item[key], `${path}.${key}`)))
        fail(`${path}.${key}`, 'expected git sha')
    literal(item.lifecycle, worktreeLifecycles, `${path}.lifecycle`)
    literal(
      item.bootstrap,
      ['not_started', 'running', 'completed', 'failed', 'cancelled'],
      `${path}.bootstrap`
    )
    if (typeof item.archived !== 'boolean') fail(`${path}.archived`, 'expected boolean')
    integerValue(item.generation, `${path}.generation`, 1)
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'WorktreeDiffSummary') {
    const item = record(value, path)
    exactKeys(item, ['worktreeId', 'added', 'removed', 'filesChanged'], [], path)
    if (!uuidPattern.test(stringValue(item.worktreeId, `${path}.worktreeId`)))
      fail(`${path}.worktreeId`, 'expected lowercase UUID')
    integerValue(item.added, `${path}.added`, 0)
    integerValue(item.removed, `${path}.removed`, 0)
    integerValue(item.filesChanged, `${path}.filesChanged`, 0)
    return value
  }
  fail(path, `unsupported registry DTO ${name}`)
}

/** Strict decoder for the M10-minted authorized-root grant DTO. */
export function decodeRootBookmark(value: unknown): RootBookmark {
  decodeRegistryDto('RootBookmark', value, 'rootBookmark')
  return value as RootBookmark
}

/** Strict decoder for the vault-held credential reference DTO (never a secret). */
export function decodeCredentialRef(value: unknown): CredentialRef {
  decodeRegistryDto('CredentialRef', value, 'credentialRef')
  return value as CredentialRef
}

/** Strict decoder for the registry Project record (#398). */
export function decodeProject(value: unknown): Project {
  decodeRegistryDto('Project', value, 'project')
  return value as Project
}

/** Strict decoder for the repository registry record (#398). */
export function decodeRepo(value: unknown): Repo {
  decodeRegistryDto('Repo', value, 'repo')
  return value as Repo
}

/** Strict decoder for the `dev.repo.inspect` reply (#398). */
export function decodeRepoInspection(value: unknown): RepoInspection {
  decodeRegistryDto('RepoInspection', value, 'repoInspection')
  return value as RepoInspection
}

/** Strict decoder for one worktree record DTO (ADR 0011). */
export function decodeWorktree(value: unknown): Worktree {
  decodeRegistryDto('Worktree', value, 'worktree')
  return value as Worktree
}
