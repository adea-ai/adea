/*
 * Source Control pane (#399): local branch/status read model, stage/unstage,
 * explicit discard with a per-file confirmation step, a CAS local commit with
 * a validated message, fetch, paged history, and a bounded plain-text diff
 * fallback. Remote push/PR flows are the separate GitHub issue.
 */
import type { DiffHunk, GitStatus } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/ui/lib/utils'
import { Download, GitCommitHorizontal, RefreshCw } from 'lucide-solid'
import { For, Show, createResource, createSignal, type JSX } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import {
  branchLabel,
  groupStatus,
  renderUnifiedDiff,
  statusLabel,
  type RenderedDiffLine,
} from './source-control-model'
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
  const [status, setStatus] = createSignal<GitStatusReply | undefined>()
  const [history, setHistory] = createSignal<
    readonly { sha: string; subject: string; authorName: string }[]
  >([])
  const [message, setMessage] = createSignal('')
  const [notice, setNotice] = createSignal<string | undefined>()
  const [confirmDiscard, setConfirmDiscard] = createSignal<string | undefined>()
  const [diff, setDiff] = createSignal<readonly RenderedDiffLine[]>([])
  const [diffTarget, setDiffTarget] = createSignal<string | undefined>()
  const [contextVersion, bumpContextVersion] = createSignal(0)

  createResource(contextVersion, async () => {
    const activeScope = scope()
    if (!activeScope || props.runtime.state().status !== 'ready') return
    const context = await resolveWorktreeContext(props.runtime, activeScope).catch(() => undefined)
    setWorktree(context)
    if (context) await refreshStatus()
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
      setStatus(reply)
    } catch (reply) {
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
      setDiff(renderUnifiedDiff(page.items))
    } catch (reply) {
      setDiff([])
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
          <p class="dev-sc__section-title">Diff — {diffTarget()}</p>
          <div class="dev-sc__diff" aria-label={`Diff for ${diffTarget()}`}>
            <For each={diff()}>
              {(line) => (
                <div class={cn(`dev-sc__diff-line--${line.kind === 'meta' ? 'meta' : line.kind}`)}>
                  {line.text}
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </section>
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
  return `${error?.error?.code ?? 'error'}: ${error?.error?.message ?? 'operation failed'}`
}
