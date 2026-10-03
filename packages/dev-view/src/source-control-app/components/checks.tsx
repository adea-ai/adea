/*
 * Checks: the branch's commits with their check state, the check runs for
 * the selected commit, the selected run's log (Failures or Full log), and
 * re-running failed jobs. Logs are untrusted text, sanitised by the host and
 * rendered as text nodes.
 */
import type { GitHubCheck, GitHubCommitSummary } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Button } from '@adea-ai/ui/components/ui/button'
import { StatusChip, type StatusTone } from '@adea-ai/ui/components/ui/status-chip'
import { Tabs, TabsList, TabsTrigger } from '@adea-ai/ui/components/ui/tabs'
import { RefreshCw } from 'lucide-solid'
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  type JSX,
} from 'solid-js'

import { errorText, type ScmClient } from '../client'
import { duration, relativeTime, shortSha } from '../model/format'
import { failureLines, logLines } from '../model/log'
import type { ProviderCapabilities, PullRequestView } from '../model/types'
import type { AppActions } from './actions'
import { RollupChip, StateMessage } from './bits'

function checkTone(check: GitHubCheck): { tone: StatusTone; label: string } {
  if (check.status !== 'completed')
    return { tone: 'info', label: check.status === 'queued' ? 'Queued' : 'Running' }
  switch (check.conclusion) {
    case 'success':
      return { tone: 'success', label: 'Passed' }
    case 'neutral':
      return { tone: 'neutral', label: 'Neutral' }
    case 'skipped':
      return { tone: 'neutral', label: 'Skipped' }
    case 'cancelled':
      return { tone: 'warning', label: 'Cancelled' }
    case 'action_required':
      return { tone: 'warning', label: 'Action required' }
    case 'stale':
      return { tone: 'unknown', label: 'Stale' }
    case 'timed_out':
      return { tone: 'danger', label: 'Timed out' }
    default:
      return { tone: 'danger', label: 'Failed' }
  }
}

/** Failing first, then running, then the rest: what needs attention leads. */
function checkRank(check: GitHubCheck): number {
  if (failed(check)) return 0
  if (check.status !== 'completed') return 1
  return check.conclusion === 'skipped' || check.conclusion === 'neutral' ? 3 : 2
}

const failed = (check: GitHubCheck) =>
  check.status === 'completed' &&
  (check.conclusion === 'failure' ||
    check.conclusion === 'timed_out' ||
    check.conclusion === 'cancelled')

export function CommitsList(props: {
  commits: readonly GitHubCommitSummary[] | undefined
  loading: boolean
  error?: string
  now: number
}): JSX.Element {
  return (
    <div class="dev-scm-conversation">
      <Show when={props.error}>
        <StateMessage title="Commits could not be loaded" description={props.error} />
      </Show>
      <Show
        when={props.commits}
        fallback={
          <Show when={props.loading}>
            <p class="dev-scm-caption" role="status">
              Loading commits…
            </p>
          </Show>
        }
      >
        {(commits) => (
          <div class="dev-scm-rows">
            <For each={commits()}>
              {(commit) => (
                <div class="dev-scm-commit-line px-3 py-1">
                  <span class="dev-scm-mono dev-scm-muted">{shortSha(commit.sha)}</span>
                  <span class="flex min-w-0 flex-col">
                    <span class="dev-scm-truncate">{commit.headline}</span>
                    <span class="dev-scm-caption">
                      {commit.authorLogin ?? commit.authorName ?? 'Unknown author'} ·{' '}
                      {relativeTime(commit.committedAt, props.now)}
                    </span>
                  </span>
                  <RollupChip state={commit.checks} />
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  )
}

export function ChecksView(props: {
  pr: PullRequestView
  commits: readonly GitHubCommitSummary[] | undefined
  client: ScmClient
  capabilities: ProviderCapabilities
  now: number
  actions: AppActions
}): JSX.Element {
  const [sha, setSha] = createSignal(props.pr.headSha)
  const [selected, setSelected] = createSignal<string>()
  const [mode, setMode] = createSignal<'failures' | 'full'>('failures')
  const [rerunning, setRerunning] = createSignal(false)
  createEffect(
    on(
      () => props.pr.headSha,
      (head) => setSha(head),
      { defer: true }
    )
  )

  const [checks, { refetch }] = createResource(
    () => ({ pr: props.pr.id, sha: sha() }),
    async (source) =>
      (await props.client.checks(source.pr, source.sha)).items.toSorted(
        (left, right) => checkRank(left) - checkRank(right) || left.name.localeCompare(right.name)
      )
  )
  const summary = createMemo(() => {
    const list = checks() ?? []
    const counts = { failing: 0, passing: 0, running: 0, skipped: 0 }
    for (const check of list) {
      if (check.status !== 'completed') counts.running += 1
      else if (failed(check)) counts.failing += 1
      else if (check.conclusion === 'skipped') counts.skipped += 1
      else counts.passing += 1
    }
    return counts
  })
  createEffect(
    on(checks, (list) => {
      if (!list) return
      if (list.some((check) => check.id === selected())) return
      setSelected((list.find(failed) ?? list[0])?.id)
    })
  )
  const selectedCheck = () => (checks() ?? []).find((check) => check.id === selected())
  const [log] = createResource(
    () =>
      props.capabilities.checkLogs && selectedCheck()?.status === 'completed'
        ? { pr: props.pr.id, id: selected()! }
        : undefined,
    async (source) => props.client.checkLog(source.pr, source.id)
  )
  const lines = createMemo(() => (log() ? logLines(log()!.text) : []))
  const shown = createMemo(() => (mode() === 'failures' ? failureLines(lines()) : lines()))
  const commit = () => (props.commits ?? []).find((entry) => entry.sha === sha())

  const rerun = async () => {
    const target = (checks() ?? []).find(failed)
    if (!target) return
    setRerunning(true)
    try {
      await props.client.rerunFailedJobs(props.pr.id, target.id)
      props.actions.notify('Failed jobs are re-running.', 'success')
      void refetch()
    } catch (error) {
      props.actions.notify(errorText(error), 'error')
    } finally {
      setRerunning(false)
    }
  }

  return (
    <div class="dev-scm-checks">
      <nav class="dev-scm-checks__commits" aria-label="Commits on this branch">
        <h2 class="dev-scm-eyebrow px-2 pb-1">Commits on this branch</h2>
        <For each={(props.commits ?? []).toReversed()}>
          {(entry) => (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="h-auto w-full justify-start"
              aria-current={entry.sha === sha() ? 'true' : undefined}
              onClick={() => setSha(entry.sha)}
            >
              <RollupChip state={entry.checks} compact />
              <span class="flex min-w-0 flex-col items-start">
                <span class="dev-scm-truncate">{entry.headline}</span>
                <span class="dev-scm-caption">
                  {shortSha(entry.sha)} · {relativeTime(entry.committedAt, props.now)}
                </span>
              </span>
            </Button>
          )}
        </For>
      </nav>
      <div class="dev-scm-checks__run">
        <div class="dev-scm-header__row">
          <div class="flex min-w-0 flex-1 flex-col">
            <h2 class="dev-scm-group__label">
              {[
                summary().failing ? `${summary().failing} failing` : '',
                summary().passing ? `${summary().passing} passing` : '',
                summary().running ? `${summary().running} running` : '',
                summary().skipped ? `${summary().skipped} skipped` : '',
              ]
                .filter(Boolean)
                .join(', ') || 'No checks'}
            </h2>
            <span class="dev-scm-caption">
              On <span class="dev-scm-mono">{shortSha(sha())}</span>
              {commit() ? ` · ${commit()!.headline}` : ''}
            </span>
          </div>
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-sm"
            tooltip="Refresh checks"
            aria-label="Refresh checks"
            onClick={() => void refetch()}
          >
            <RefreshCw aria-hidden="true" />
          </ActionButton>
          <Show
            when={
              props.capabilities.rerunFailedJobs &&
              summary().failing > 0 &&
              sha() === props.pr.headSha
            }
          >
            <ActionButton
              type="button"
              variant="outline"
              busy={rerunning()}
              busyLabel="Re-running"
              disabled={rerunning()}
              onClick={() => void rerun()}
            >
              Re-run failed jobs
            </ActionButton>
          </Show>
        </div>
        <Show when={checks.error}>
          <StateMessage title="Checks could not be loaded" description={errorText(checks.error)} />
        </Show>
        <Show
          when={!checks.loading || checks()}
          fallback={
            <p class="dev-scm-caption" role="status">
              Loading checks…
            </p>
          }
        >
          <Show
            when={(checks() ?? []).length > 0}
            fallback={<StateMessage title="No checks ran on this commit" />}
          >
            <div class="dev-scm-rows" role="list" aria-label="Check runs">
              <For each={checks()}>
                {(check) => {
                  const tone = () => checkTone(check)
                  return (
                    <div
                      role="listitem"
                      class={cn('dev-scm-check', {
                        'dev-scm-check--selected': check.id === selected(),
                      })}
                    >
                      <StatusChip tone={tone().tone} label={tone().label} />
                      <span class="dev-scm-mono dev-scm-truncate">{check.name}</span>
                      <span class="dev-scm-caption dev-scm-truncate">{check.title ?? ''}</span>
                      <span class="dev-scm-caption">
                        {duration(check.startedAt, check.completedAt)}
                      </span>
                      <Show when={check.status === 'completed' && props.capabilities.checkLogs}>
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          aria-pressed={check.id === selected()}
                          aria-label={`View log for ${check.name}`}
                          onClick={() => setSelected(check.id)}
                        >
                          View log
                        </Button>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </Show>
        <Show when={selectedCheck()}>
          {(check) => (
            <section class="dev-scm-log" aria-label={`Log for ${check().name}`}>
              <div class="dev-scm-log__head">
                <span class="dev-scm-mono dev-scm-truncate flex-1">{check().name}</span>
                <Tabs value={mode()} onChange={(value) => setMode(value as 'failures' | 'full')}>
                  <TabsList appearance="segmented" aria-label="Log view">
                    <TabsTrigger appearance="segmented" value="failures">
                      Failures
                    </TabsTrigger>
                    <TabsTrigger appearance="segmented" value="full">
                      Full log
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!log()}
                  onClick={() =>
                    void navigator.clipboard?.writeText(
                      shown()
                        .map((line) => line.text)
                        .join('\n')
                    )
                  }
                >
                  Copy
                </Button>
              </div>
              <div class="dev-scm-log__body" role="log" aria-label="Log lines">
                <Show
                  when={!log.loading}
                  fallback={<p class="dev-scm-caption px-3">Loading the log…</p>}
                >
                  <Show when={log.error}>
                    <p class="dev-scm-caption px-3" role="alert">
                      {errorText(log.error)}
                    </p>
                  </Show>
                  <Show when={log()?.truncated}>
                    <p class="dev-scm-caption px-3">Showing the end of a long log.</p>
                  </Show>
                  <Show when={log() && shown().length === 0}>
                    <p class="dev-scm-caption px-3">
                      {mode() === 'failures'
                        ? 'No failure lines found. Switch to Full log.'
                        : 'The log is empty.'}
                    </p>
                  </Show>
                  <For each={shown()}>
                    {(line) => (
                      <div
                        class={cn('dev-scm-log__line', {
                          'dev-scm-log__line--failure': line.failure,
                        })}
                      >
                        <span class="dev-scm-diff__num">{line.number}</span>
                        <span class="dev-scm-diff__code">{line.text}</span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </section>
          )}
        </Show>
      </div>
    </div>
  )
}
