/*
 * Source Control pane (#399): local branch/status read model, stage/unstage,
 * explicit discard with a per-file confirmation step, a CAS local commit with
 * a validated message, fetch, paged history, and a bounded plain-text diff
 * fallback. The remote section (#423) layers GitHub push, draft-PR creation,
 * PR/check state, and update-branch — every mutation through its plan/commit
 * pair, all provider text rendered as untrusted bounded plain text.
 */
import type {
  DiffHunk,
  GitStatus,
  GitHubCheck,
  GitHubPullRequest,
  GitHubRepository,
  Scope,
} from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/ui/lib/utils'
import { Download, GitCommitHorizontal, RefreshCw } from 'lucide-solid'
import { For, Show, createResource, createSignal, onCleanup, type JSX } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import {
  branchLabel,
  groupStatus,
  renderUnifiedDiff,
  splitFileHunks,
  statusLabel,
} from './source-control-model'
import {
  aheadBehindLabel,
  checksLabel,
  pullRequestStateLabel,
  reviewDecisionLabel,
  summarizeChecks,
  truncateUntrusted,
  type CheckSummary,
} from './remote-model'
import {
  cacheStatus,
  emptyStatusCache,
  invalidateStatus,
  pushInvalidationDecision,
  refenceStatusCache,
  type StatusCacheSnapshot,
} from '../files/status-cache'
import {
  executeOperation,
  resolveWorktreeContext,
  type WorktreeContext,
} from '../files/worktree-context'
import '../files/files-pane.css'

export type SourceControlPaneProps = Readonly<{
  runtime: DevRuntimeService
  runtimeSessionId?: string
}>

type StatusEntry = GitStatus['entries'][number]

type GitStatusReply = GitStatus

export function SourceControlPane(props: SourceControlPaneProps): JSX.Element {
  const scope = () => props.runtime.preferenceScope?.()
  const [worktree, setWorktree] = createSignal<WorktreeContext | undefined>()
  // The status cache follows the watcher lane's honesty contract (#399
  // residue): invalidation and failed refreshes turn it UNDEFINED — never a
  // stale listing labeled fresh — and only a successful dispatch through the
  // capability-checked gate repopulates it.
  const [statusCache, setStatusCache] = createSignal<StatusCacheSnapshot<GitStatusReply>>(
    emptyStatusCache(0)
  )
  const status = (): GitStatusReply | undefined => statusCache().value
  const [history, setHistory] = createSignal<
    readonly { sha: string; subject: string; authorName: string }[]
  >([])
  const [message, setMessage] = createSignal('')
  const [notice, setNotice] = createSignal<string | undefined>()
  const [confirmDiscard, setConfirmDiscard] = createSignal<string | undefined>()
  // The fetched diff page stays structural so each hunk can carry its own
  // stage/unstage affordance (#399 residue); rendering is derived per hunk.
  const [diffHunks, setDiffHunks] = createSignal<readonly DiffHunk[]>([])
  const [diffTarget, setDiffTarget] = createSignal<string | undefined>()
  const [diffMode, setDiffMode] = createSignal<'worktree' | 'staged'>('worktree')
  const [contextVersion, bumpContextVersion] = createSignal(0)

  // ── Push invalidation (M12) ─────────────────────────────────────────────────
  //
  // When the shell's watcher lane publishes `git.statusInvalidated` over the
  // authenticated event stream, this pane consumes the push through the same
  // honesty contract as the watcher itself: a same-generation tree change
  // kills the cache and repopulates through the capability-checked pull, a
  // moved generation re-resolves the context (re-fence), and the watcher's
  // own refreshed/stopped bookkeeping is ignored. Push never carries status
  // bytes, and when the event surface is absent (web non-desktop runtime)
  // the pane simply keeps generation-fenced pull.
  let disposePush: (() => void) | undefined
  let pushWired = false
  function wirePushInvalidation(activeScope: Scope): void {
    if (pushWired) return
    pushWired = true
    const events = props.runtime.events?.()
    if (!events) return
    disposePush = events.on('git.statusInvalidated', activeScope, (event) => {
      const context = worktree()
      if (!context) return
      const decision = pushInvalidationDecision(context, event)
      if (decision === 'invalidate') void refreshStatus()
      else if (decision === 'refence') void refresh()
    })
  }
  onCleanup(() => disposePush?.())

  createResource(contextVersion, async () => {
    const activeScope = scope()
    if (!activeScope || props.runtime.state().status !== 'ready') return
    wirePushInvalidation(activeScope)
    const context = await resolveWorktreeContext(props.runtime, activeScope).catch(() => undefined)
    setWorktree(context)
    if (context) {
      // A re-resolved context whose generation moved is a re-fence: the old
      // cache dies with its generation before the refresh re-proves state.
      setStatusCache((current) => refenceStatusCache(current, context.generation))
      await refreshStatus()
    }
  })

  async function refresh(): Promise<void> {
    bumpContextVersion((version) => version + 1)
    await refreshStatus()
    await loadHistory()
  }

  async function refreshStatus(): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope) return
    try {
      const reply = await executeOperation<GitStatusReply>(
        props.runtime,
        activeScope,
        'dev.git.status',
        { worktreeId: context.worktreeId, limit: 500 },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      setStatusCache(cacheStatus(reply, context.generation))
    } catch (reply) {
      // A failed read publishes nothing: the cache goes undefined (honest
      // miss), never stale-fresh.
      setStatusCache(invalidateStatus)
      setNotice(describeError(reply))
    }
  }

  async function stagePaths(paths: readonly string[]): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope) return
    try {
      await executeOperation(
        props.runtime,
        activeScope,
        'dev.git.stage',
        { worktreeId: context.worktreeId, paths: paths.map(toWorkspacePath(context)) },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      await refreshStatus()
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  async function unstagePaths(paths: readonly string[]): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope) return
    try {
      await executeOperation(
        props.runtime,
        activeScope,
        'dev.git.unstage',
        { worktreeId: context.worktreeId, paths: paths.map(toWorkspacePath(context)) },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      await refreshStatus()
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  async function discard(entry: StatusEntry): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope) return
    // Explicit preview + confirmation: the same click position requires a
    // second press before anything destructive happens.
    if (confirmDiscard() !== entry.path.relativePath) {
      setConfirmDiscard(entry.path.relativePath)
      setNotice(`discard ${entry.path.relativePath}: press Discard again to confirm`)
      return
    }
    setConfirmDiscard(undefined)
    setNotice(undefined)
    try {
      const plan = await executeOperation<{
        id: string
        digest: string
        blockers: readonly { message: string }[]
      }>(
        props.runtime,
        activeScope,
        'dev.git.discardPlan',
        {
          worktreeId: context.worktreeId,
          paths: [toWorkspacePath(context)(entry.path.relativePath)],
        },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      if (plan.blockers.length > 0) {
        setNotice(plan.blockers.map((blocker) => blocker.message).join('; '))
        return
      }
      await executeOperation(
        props.runtime,
        activeScope,
        'dev.git.discardCommit',
        { planId: plan.id, planDigest: plan.digest },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      await refreshStatus()
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  async function commitStaged(): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    const current = status()
    if (!context || !activeScope || !current) return
    const trimmed = message().trim()
    if (trimmed.length === 0) {
      setNotice('a commit message is required')
      return
    }
    try {
      await executeOperation(
        props.runtime,
        activeScope,
        'dev.git.commit',
        {
          worktreeId: context.worktreeId,
          message: trimmed,
          expectedIndexSha: current.indexSha,
        },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      setMessage('')
      setNotice(undefined)
      await refreshStatus()
      await loadHistory()
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  async function fetch(): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope) return
    try {
      await executeOperation(
        props.runtime,
        activeScope,
        'dev.git.fetch',
        { worktreeId: context.worktreeId, remoteName: 'origin', prune: true },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      setNotice('fetch completed')
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  async function loadHistory(): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope) return
    try {
      const page = await executeOperation<{
        items: readonly { sha: string; subject: string; authorName: string }[]
      }>(
        props.runtime,
        activeScope,
        'dev.git.history',
        { worktreeId: context.worktreeId, limit: 20 },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      setHistory(page.items)
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  async function showDiff(relativePath: string, mode: 'worktree' | 'staged'): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope) return
    setDiffTarget(relativePath)
    setDiffMode(mode)
    try {
      const page = await executeOperation<{ items: readonly DiffHunk[] }>(
        props.runtime,
        activeScope,
        'dev.git.diff',
        {
          worktreeId: context.worktreeId,
          mode,
          path: toWorkspacePath(context)(relativePath),
          limit: 2000,
        },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      setDiffHunks(page.items)
    } catch (reply) {
      setDiffHunks([])
      setNotice(describeError(reply))
    }
  }

  /** Per-hunk staging (#399 residue): plan/commit a `git apply --cached`
   *  patch over exactly the selected hunk, then re-read status and the open
   *  diff so the pane shows the post-application state. */
  async function stageHunk(hunk: DiffHunk, direction: 'stage' | 'unstage'): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope) return
    try {
      const plan = await executeOperation<{ id: string; digest: string }>(
        props.runtime,
        activeScope,
        'dev.git.hunkStagingPlan',
        {
          worktreeId: context.worktreeId,
          direction,
          hunks: [hunk],
        },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      await executeOperation(
        props.runtime,
        activeScope,
        'dev.git.hunkStagingCommit',
        { planId: plan.id, planDigest: plan.digest },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      setNotice(undefined)
      await refreshStatus()
      const target = diffTarget()
      if (target) await showDiff(target, direction === 'stage' ? 'worktree' : 'staged')
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  const grouped = () => {
    const current = status()
    if (!current) {
      return { staged: [], unstaged: [], untracked: [], conflicted: [] }
    }
    return groupStatus(current)
  }

  return (
    <section class="dev-sc" aria-label="Source control">
      <div class="dev-sc__header">
        <GitCommitHorizontal aria-hidden="true" />
        <strong>
          <Show when={status()} fallback={'no repository state'}>
            {(current) => branchLabel(current())}
          </Show>
        </strong>
        <button
          type="button"
          class="dev-icon-button"
          aria-label="Refresh status"
          onClick={() => void refresh()}
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <button
          type="button"
          class="dev-icon-button"
          aria-label="Fetch from origin"
          onClick={() => void fetch()}
        >
          <Download aria-hidden="true" />
        </button>
      </div>
      <Show when={notice()}>
        {(shown) => (
          <p class="dev-terminal-muted dev-sc__section-title" role="alert">
            {shown()}
          </p>
        )}
      </Show>
      <RemoteSection
        runtime={props.runtime}
        scope={scope()}
        worktree={worktree()}
        status={status()}
        onNotice={setNotice}
        onRefresh={() => void refresh()}
      />
      <Show
        when={worktree()}
        fallback={
          <p class="dev-empty-state">No ready worktree context exists on this runtime node yet.</p>
        }
      >
        <div class="dev-sc__commit">
          <textarea
            aria-label="Commit message"
            placeholder={`Commit message (${(grouped().staged.length + grouped().unstaged.filter((entry) => entry.staged !== '.').length).toString()} staged files)`}
            value={message()}
            onInput={(event) => setMessage(event.currentTarget.value)}
          />
          <button
            type="button"
            class="dev-button"
            disabled={grouped().staged.length === 0}
            onClick={() => void commitStaged()}
          >
            Commit staged
          </button>
        </div>
        <Show when={grouped().conflicted.length > 0}>
          <p class="dev-sc__section-title">Conflicts</p>
          <For each={grouped().conflicted}>
            {(entry) => <StatusRow entry={entry} kind="conflicted" onDiff={showDiff} />}
          </For>
        </Show>
        <p class="dev-sc__section-title">Staged</p>
        <div class="dev-sc__list">
          <For each={grouped().staged}>
            {(entry) => (
              <StatusRow
                entry={entry}
                kind="staged"
                onDiff={showDiff}
                onUnstage={() => void unstagePaths([entry.path.relativePath])}
              />
            )}
          </For>
        </div>
        <p class="dev-sc__section-title">Changes</p>
        <div class="dev-sc__list">
          <For each={[...grouped().unstaged, ...grouped().untracked]}>
            {(entry) => (
              <StatusRow
                entry={entry}
                kind={entry.untracked ? 'untracked' : 'unstaged'}
                onDiff={showDiff}
                onStage={() => void stagePaths([entry.path.relativePath])}
                onDiscard={entry.untracked ? undefined : () => void discard(entry)}
                discardArmed={confirmDiscard() === entry.path.relativePath}
              />
            )}
          </For>
        </div>
        <p class="dev-sc__section-title">History</p>
        <div class="dev-sc__list">
          <For each={history()}>
            {(commit) => (
              <div class="dev-files__row">
                <span class="dev-files__name" title={commit.sha}>
                  {commit.subject} — {commit.authorName}
                </span>
              </div>
            )}
          </For>
          <div class="dev-sc__actions">
            <button type="button" class="dev-button" onClick={() => void loadHistory()}>
              Load history
            </button>
          </div>
        </div>
        <Show when={diffTarget()}>
          <p class="dev-sc__section-title">
            Diff — {diffTarget()} ({diffMode() === 'staged' ? 'staged' : 'worktree'})
          </p>
          <div class="dev-sc__diff" aria-label={`Diff for ${diffTarget()}`}>
            <For each={splitFileHunks(diffHunks())}>
              {(group) => (
                <For each={group.hunks}>
                  {(hunk, hunkIndex) => (
                    <div class="dev-sc__diff-hunk">
                      <div class="dev-sc__diff-hunk-bar">
                        <span class="dev-sc__diff-line--meta">
                          {`hunk ${hunkIndex() + 1}: @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
                        </span>
                        <Show
                          when={diffMode() === 'staged'}
                          fallback={
                            <button
                              type="button"
                              class="dev-sc__hunk-action"
                              aria-label={`Stage hunk ${hunkIndex() + 1} of ${group.path}`}
                              onClick={() => void stageHunk(hunk, 'stage')}
                            >
                              Stage hunk
                            </button>
                          }
                        >
                          <button
                            type="button"
                            class="dev-sc__hunk-action"
                            aria-label={`Unstage hunk ${hunkIndex() + 1} of ${group.path}`}
                            onClick={() => void stageHunk(hunk, 'unstage')}
                          >
                            Unstage hunk
                          </button>
                        </Show>
                      </div>
                      <For each={renderUnifiedDiff([hunk]).slice(1)}>
                        {(line) => (
                          <div
                            class={cn(
                              `dev-sc__diff-line--${line.kind === 'meta' ? 'meta' : line.kind}`
                            )}
                          >
                            {line.text}
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              )}
            </For>
            <Show when={diffHunks().length === 0}>
              <div class="dev-sc__diff-line--meta">no textual changes</div>
            </Show>
          </div>
        </Show>
      </Show>
    </section>
  )
}

/*
 * Remote (#423): GitHub availability, push (plan/commit with a second-press
 * confirmation), draft-PR creation for the current branch, PR/check state,
 * and update-branch preview + explicit commit. Every provider-derived string
 * passes through `truncateUntrusted` and renders as a Solid text node —
 * check names, PR titles, and error text can never become markup or commands.
 */
function RemoteSection(props: {
  runtime: DevRuntimeService
  scope?: ReturnType<NonNullable<DevRuntimeService['preferenceScope']>>
  worktree: WorktreeContext | undefined
  status: GitStatusReply | undefined
  onNotice(message: string | undefined): void
  onRefresh(): void
}): JSX.Element {
  const [repository, setRepository] = createSignal<GitHubRepository | undefined>()
  const [pullRequest, setPullRequest] = createSignal<GitHubPullRequest | undefined>()
  const [checks, setChecks] = createSignal<readonly GitHubCheck[]>([])
  const [prBase, setPrBase] = createSignal('main')
  const [pushArmed, setPushArmed] = createSignal(false)
  const [updateArmed, setUpdateArmed] = createSignal(false)
  const [remoteNotice, setRemoteNotice] = createSignal<string | undefined>()

  const remoteAvailable = () => props.worktree?.repoId !== undefined

  createResource(remoteAvailable, async (available) => {
    setRemoteNotice(undefined)
    if (!available || !props.scope) return
    try {
      await executeOperation(props.runtime, props.scope, 'dev.github.account', {})
    } catch (reply) {
      setRemoteNotice(describeError(reply))
      return
    }
    await loadRepository()
    await loadPullRequest()
  })

  async function loadRepository(): Promise<void> {
    const activeScope = props.scope
    const repoId = props.worktree?.repoId
    if (!activeScope || !repoId) return
    try {
      const repo = await executeOperation<GitHubRepository>(
        props.runtime,
        activeScope,
        'dev.github.repository',
        { repoId },
        { kind: 'repository', id: repoId, generation: 0 }
      )
      setRepository(repo)
      setRemoteNotice(undefined)
    } catch (reply) {
      setRepository(undefined)
      setRemoteNotice(describeError(reply))
    }
  }

  async function loadPullRequest(): Promise<void> {
    const activeScope = props.scope
    const repoId = props.worktree?.repoId
    if (!activeScope || !repoId) return
    try {
      const page = await executeOperation<{ items: readonly GitHubPullRequest[] }>(
        props.runtime,
        activeScope,
        'dev.github.pullRequests',
        { repoId, state: 'open', limit: 50 },
        { kind: 'repository', id: repoId, generation: 0 }
      )
      const headRef = props.status?.headRef
      setPullRequest(page.items.find((pr) => headRef !== undefined && pr.headRef === headRef))
    } catch (reply) {
      setPullRequest(undefined)
      setRemoteNotice(describeError(reply))
    }
  }

  async function push(): Promise<void> {
    const activeScope = props.scope
    const context = props.worktree
    const current = props.status
    const repoId = context?.repoId
    const ref = current?.headRef
    const headSha = current?.headSha
    if (!activeScope || !context || !repoId || !ref || !headSha) return
    // Plan first, then an explicit second press on the same button commits.
    if (!pushArmed()) {
      setPushArmed(true)
      setRemoteNotice(`push ${ref}: press again to confirm`)
      return
    }
    setPushArmed(false)
    setRemoteNotice(undefined)
    try {
      const plan = await executeOperation<{
        id: string
        digest: string
        blockers: readonly { message: string }[]
      }>(
        props.runtime,
        activeScope,
        'dev.github.pushPlan',
        { repoId, worktreeId: context.worktreeId, ref, expectedLocalSha: headSha },
        { kind: 'repository', id: repoId, generation: 0 }
      )
      if (plan.blockers.length > 0) {
        setRemoteNotice(
          plan.blockers.map((blocker) => truncateUntrusted(blocker.message)).join('; ')
        )
        return
      }
      await executeOperation(
        props.runtime,
        activeScope,
        'dev.github.pushCommit',
        { planId: plan.id, planDigest: plan.digest },
        { kind: 'repository', id: repoId, generation: 0 }
      )
      setRemoteNotice(`pushed ${truncateUntrusted(ref)}`)
      props.onRefresh()
    } catch (reply) {
      setRemoteNotice(describeError(reply))
    }
  }

  async function createDraftPullRequest(): Promise<void> {
    const activeScope = props.scope
    const repoId = props.worktree?.repoId
    const ref = props.status?.headRef
    if (!activeScope || !repoId || !ref) return
    const base = prBase().trim()
    if (base.length === 0 || base === ref) {
      setRemoteNotice('a distinct base branch is required')
      return
    }
    try {
      const pr = await executeOperation<GitHubPullRequest>(
        props.runtime,
        activeScope,
        'dev.github.createPullRequest',
        {
          repoId,
          headRef: ref,
          baseRef: base,
          title: truncateUntrusted(ref, 200),
          body: '',
          draft: true,
        },
        { kind: 'repository', id: repoId, generation: 0 }
      )
      setPullRequest(pr)
      setRemoteNotice(
        pr.reconciled === true ? 'existing pull request found' : 'draft pull request created'
      )
    } catch (reply) {
      setRemoteNotice(describeError(reply))
    }
  }

  async function loadChecks(): Promise<void> {
    const activeScope = props.scope
    const pr = pullRequest()
    if (!activeScope || !pr) return
    try {
      const page = await executeOperation<{ items: readonly GitHubCheck[] }>(
        props.runtime,
        activeScope,
        'dev.github.checks',
        { pullRequestId: pr.id, limit: 100 },
        { kind: 'pull_request', id: pr.id, generation: 0 }
      )
      setChecks(page.items)
    } catch (reply) {
      setRemoteNotice(describeError(reply))
    }
  }

  async function updateBranch(): Promise<void> {
    const activeScope = props.scope
    const context = props.worktree
    const pr = pullRequest()
    if (!activeScope || !context || !pr) return
    if (!updateArmed()) {
      setUpdateArmed(true)
      setRemoteNotice(`merge ${pr.baseRef} into ${pr.headRef}: press again to confirm`)
      return
    }
    setUpdateArmed(false)
    setRemoteNotice(undefined)
    try {
      const plan = await executeOperation<{
        id: string
        digest: string
        blockers: readonly { message: string }[]
      }>(
        props.runtime,
        activeScope,
        'dev.github.updateBranchPlan',
        {
          pullRequestId: pr.id,
          worktreeId: context.worktreeId,
          expectedGeneration: context.generation,
          strategy: 'merge',
          expectedHeadSha: pr.headSha,
          expectedBaseSha: pr.baseSha,
        },
        { kind: 'pull_request', id: pr.id, generation: context.generation }
      )
      if (plan.blockers.length > 0) {
        setRemoteNotice(
          plan.blockers.map((blocker) => truncateUntrusted(blocker.message)).join('; ')
        )
        return
      }
      const result = await executeOperation<{ state: string; conflictedPaths?: readonly string[] }>(
        props.runtime,
        activeScope,
        'dev.github.updateBranchCommit',
        { planId: plan.id, planDigest: plan.digest },
        { kind: 'pull_request', id: pr.id, generation: context.generation }
      )
      if (result.state === 'conflicted') {
        setRemoteNotice(
          `merge conflicted in ${(result.conflictedPaths ?? []).length} path(s); abort with git merge --abort`
        )
      } else {
        setRemoteNotice(`branch ${result.state}`)
      }
      props.onRefresh()
      await loadPullRequest()
    } catch (reply) {
      setRemoteNotice(describeError(reply))
    }
  }

  const checkSummary = (): CheckSummary => summarizeChecks(checks())

  return (
    <Show when={remoteAvailable()}>
      <p class="dev-sc__section-title">Remote</p>
      <Show when={remoteNotice()}>
        {(shown) => (
          <p class="dev-terminal-muted dev-sc__section-title" role="alert">
            {shown()}
          </p>
        )}
      </Show>
      <div class="dev-sc__actions">
        <button type="button" class="dev-button" onClick={() => void loadRepository()}>
          Refresh remote
        </button>
        <Show
          when={props.status?.headSha}
          fallback={<span class="dev-terminal-muted">no commits to push</span>}
        >
          <button type="button" class="dev-button" onClick={() => void push()}>
            {pushArmed() ? 'Confirm push' : 'Push'}
          </button>
        </Show>
      </div>
      <Show when={repository()}>
        {(repo) => (
          <div class="dev-files__row">
            <span class="dev-files__name">
              {truncateUntrusted(repo().fullName)} ({truncateUntrusted(repo().defaultBranch)},{' '}
              {repo().freshness})
            </span>
          </div>
        )}
      </Show>
      <Show
        when={pullRequest()}
        fallback={
          <div class="dev-sc__actions">
            <input
              aria-label="Base branch for the new pull request"
              placeholder="base branch"
              value={prBase()}
              onInput={(event) => setPrBase(event.currentTarget.value)}
            />
            <button type="button" class="dev-button" onClick={() => void createDraftPullRequest()}>
              Create draft PR
            </button>
          </div>
        }
      >
        {(pr) => (
          <>
            <div class="dev-files__row">
              <span class="dev-files__name">
                #{pr().number} {truncateUntrusted(pr().title)} — {pullRequestStateLabel(pr())}
                <Show when={reviewDecisionLabel(pr().reviewDecision)}>
                  {(decision) => <> — {decision()}</>}
                </Show>
              </span>
            </div>
            <Show when={pr().aheadBehind}>
              {(aheadBehind) => (
                <div class="dev-files__row">
                  <span class="dev-terminal-muted">{aheadBehindLabel(aheadBehind())}</span>
                </div>
              )}
            </Show>
            <div class="dev-files__row">
              <span class="dev-files__badge">{checksLabel(checkSummary())}</span>
              <button type="button" class="dev-files__delete" onClick={() => void loadChecks()}>
                Load checks
              </button>
            </div>
            <div class="dev-sc__list">
              <For each={checks()}>
                {(check) => (
                  <div class="dev-files__row">
                    <span class="dev-files__name" title={truncateUntrusted(check.name, 400)}>
                      {truncateUntrusted(check.name)}
                    </span>
                    <span class="dev-files__badge">{check.conclusion ?? check.status}</span>
                  </div>
                )}
              </For>
            </div>
            <div class="dev-sc__actions">
              <button type="button" class="dev-button" onClick={() => void updateBranch()}>
                {updateArmed() ? 'Confirm update branch' : 'Update branch (merge base)'}
              </button>
            </div>
          </>
        )}
      </Show>
    </Show>
  )
}

function StatusRow(props: {
  entry: StatusEntry
  kind: 'staged' | 'unstaged' | 'untracked' | 'conflicted'
  onDiff(path: string, mode: 'worktree' | 'staged'): Promise<void> | void
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
  discardArmed?: boolean
}): JSX.Element {
  const code = () =>
    props.kind === 'staged'
      ? props.entry.staged
      : props.kind === 'untracked'
        ? '?'
        : props.entry.unstaged
  return (
    <div class="dev-files__row">
      <button
        type="button"
        class="dev-files__name"
        title={`${statusLabel(code())}: ${props.entry.path.relativePath}`}
        onClick={() =>
          void props.onDiff(
            props.entry.path.relativePath,
            props.kind === 'staged' ? 'staged' : 'worktree'
          )
        }
      >
        {props.entry.path.relativePath}
      </button>
      <span class="dev-files__badge">{code()}</span>
      <Show when={props.onStage}>
        <button type="button" class="dev-files__delete" onClick={() => props.onStage?.()}>
          Stage
        </button>
      </Show>
      <Show when={props.onUnstage}>
        <button type="button" class="dev-files__delete" onClick={() => props.onUnstage?.()}>
          Unstage
        </button>
      </Show>
      <Show when={props.onDiscard}>
        <button type="button" class="dev-files__delete" onClick={() => props.onDiscard?.()}>
          {props.discardArmed ? 'Confirm' : 'Discard'}
        </button>
      </Show>
    </div>
  )
}

function toWorkspacePath(
  context: WorktreeContext
): (relativePath: string) => Record<string, unknown> {
  return (relativePath) => ({
    worktreeId: context.worktreeId,
    rootIdentity: context.rootIdentity,
    relativePath,
  })
}

function describeError(reply: unknown): string {
  const error = reply as { error?: { code?: string; message?: string } }
  const code = error?.error?.code ?? 'error'
  const message = truncateUntrusted(error?.error?.message ?? 'operation failed')
  return `${code}: ${message}`
}
