// Typed error contract for the M12 #397 worktree lifecycle service.
//
// Codes are the exact `DevErrorCode` strings from the Dev Runtime contract
// (`packages/types/src/dev-runtime.ts`); the desktop shell is a standalone
// bundle, so the worktree-relevant values are mirrored here and the M10
// channel layer maps them into `DevError` replies verbatim. Messages may
// change; the code, retryability, and remediation shape are API.
export type WorktreeErrorCode =
  | 'not_found'
  | 'unauthorized'
  | 'identity_mismatch'
  | 'stale_generation'
  | 'stale_version'
  | 'invalid_state'
  | 'corrupt_state'
  | 'already_completed'
  | 'idempotency_conflict'
  | 'unauthorized_root'
  | 'path_escape'
  | 'symlink_rejected'
  | 'special_file_rejected'
  | 'file_changed'
  | 'not_git_repo'
  | 'gitdir_unproven'
  | 'remote_unavailable'
  | 'remote_changed'
  | 'auth_required'
  | 'base_not_found'
  | 'name_collision'
  | 'path_collision'
  | 'bootstrap_denied'
  | 'bootstrap_failed'
  | 'dirty'
  | 'unpushed'
  | 'behind'
  | 'conflicted'
  | 'protected_branch'
  | 'external_ownership'
  | 'dangerous_path'
  | 'nested_worktree'
  | 'lock_timeout'
  | 'limit_exceeded'
  | 'timeout'
  | 'cancelled'
  | 'leased'
  | 'ownership_unproven'
  | 'plan_stale'
  | 'cleanup_blocked'
  | 'cleanup_partial'
  | 'recovery_required'
  | 'rollback_failed'

const RETRYABLE_CODES: ReadonlySet<WorktreeErrorCode> = new Set([
  'remote_unavailable',
  'lock_timeout',
  'timeout',
  'cancelled',
])

export type WorktreeRemediation = Readonly<{
  action: string
  parameters?: Readonly<Record<string, string>>
}>

export class WorktreeError extends Error {
  readonly retryable: boolean
  readonly remediation?: WorktreeRemediation

  constructor(
    readonly code: WorktreeErrorCode,
    message: string,
    remediation?: WorktreeRemediation
  ) {
    super(message)
    this.name = 'WorktreeError'
    this.retryable = RETRYABLE_CODES.has(code)
    if (remediation) this.remediation = remediation
  }
}

export function expectWorktreeError(run: () => unknown): WorktreeError {
  try {
    run()
  } catch (error) {
    if (error instanceof WorktreeError) return error
    throw error
  }
  throw new Error('expected WorktreeError')
}
