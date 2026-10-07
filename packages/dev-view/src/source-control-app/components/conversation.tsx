/*
 * The Conversation tab: the description, then the timeline — comments,
 * reviews, pushed commits with their check state, review threads with reply
 * and resolve, and lifecycle events — then the comment box. Every provider
 * string renders as text; nothing here forwards text to an agent.
 */
import type { GitHubTimelineItem } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Textarea } from '@adea-ai/ui/components/ui/textarea'
import {
  Check,
  CircleX,
  Eye,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  Upload,
  UserPlus,
} from 'lucide-solid'
import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  type Component,
  type JSX,
} from 'solid-js'

import { errorText, type ScmClient } from '../client'
import { threadExcerpt } from '../model/diff'
import { displayLogin, relativeTime, shortSha } from '../model/format'
import type { PullRequestView } from '../model/types'
import type { AppActions } from './actions'
import { EventMark, Person, PersonAvatar, RollupChip } from './bits'
import { RichText } from './rich-text'

type Commit = Extract<GitHubTimelineItem, { kind: 'commit' }>
type Thread = Extract<GitHubTimelineItem, { kind: 'thread' }>

/** Consecutive commits collapse into one "pushed N commits" entry. */
type Entry =
  | GitHubTimelineItem
  | Readonly<{ kind: 'push'; id: string; commits: readonly Commit[]; createdAt: string }>

export function groupTimeline(items: readonly GitHubTimelineItem[]): readonly Entry[] {
  const out: Entry[] = []
  for (const item of items) {
    // A review with no summary is only the carrier of its inline threads.
    if (item.kind === 'review' && item.state === 'commented' && item.body.trim().length === 0)
      continue
    const last = out.at(-1)
    if (item.kind === 'commit' && last?.kind === 'push') {
      out[out.length - 1] = { ...last, commits: [...last.commits, item] }
      continue
    }
    if (item.kind === 'commit') {
      out.push({ kind: 'push', id: `push:${item.id}`, commits: [item], createdAt: item.createdAt })
      continue
    }
    out.push(item)
  }
  return out
}

const eventText: Record<Extract<GitHubTimelineItem, { kind: 'event' }>['event'], string> = {
  merged: 'merged this pull request',
  closed: 'closed this pull request',
  reopened: 'reopened this pull request',
  ready_for_review: 'marked this pull request ready for review',
  converted_to_draft: 'converted this pull request to a draft',
  review_requested: 'requested a review',
  head_ref_force_pushed: 'force-pushed the branch',
  base_ref_changed: 'changed the base branch',
}

type EventKind = Extract<GitHubTimelineItem, { kind: 'event' }>['event']
type Mark = Readonly<{
  icon: Component
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
}>

const eventMark: Record<EventKind, Mark> = {
  merged: { icon: GitMerge, tone: 'info' },
  closed: { icon: GitPullRequestClosed, tone: 'danger' },
  reopened: { icon: GitPullRequest, tone: 'success' },
  ready_for_review: { icon: Eye, tone: 'info' },
  converted_to_draft: { icon: GitPullRequestDraft, tone: 'neutral' },
  review_requested: { icon: UserPlus, tone: 'neutral' },
  head_ref_force_pushed: { icon: Upload, tone: 'warning' },
  base_ref_changed: { icon: GitBranch, tone: 'neutral' },
}

const reviewMark: Record<string, Mark> = {
  approved: { icon: Check, tone: 'success' },
  changes_requested: { icon: FileDiff, tone: 'danger' },
  commented: { icon: MessageSquare, tone: 'neutral' },
  dismissed: { icon: CircleX, tone: 'neutral' },
  pending: { icon: Eye, tone: 'neutral' },
}

const reviewText: Record<string, string> = {
  approved: 'approved these changes',
  changes_requested: 'requested changes',
  commented: 'reviewed',
  dismissed: 'left a review that was dismissed',
  pending: 'started a review',
}

export function ThreadCard(props: {
  thread: Thread
  pr: PullRequestView
  client: ScmClient
  now: number
  actions: AppActions
  onChanged(thread: Thread): void
}): JSX.Element {
  const [reply, setReply] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const send = async () => {
    const body = reply().trim()
    if (!body) return
    setBusy(true)
    try {
      const updated = await props.client.threadReply(props.pr.id, props.thread.id, body)
      if (updated.kind === 'thread') props.onChanged(updated)
      setReply('')
    } catch (error) {
      props.actions.notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }
  const resolve = async () => {
    setBusy(true)
    try {
      const updated = await props.client.threadResolve(
        props.pr.id,
        props.thread.id,
        !props.thread.resolved
      )
      if (updated.kind === 'thread') props.onChanged(updated)
    } catch (error) {
      props.actions.notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }
  const excerpt = () => threadExcerpt(props.thread.diffHunk ?? '')
  return (
    <article class="dev-scm-card" aria-label={`Review thread on ${props.thread.path}`}>
      <div class="dev-scm-card__head">
        <Person actor={props.thread.comments[0]?.author} />
        <span class="dev-scm-muted">commented on</span>
        <span class="dev-scm-mono dev-scm-truncate">
          {props.thread.path}
          {props.thread.line ? `:${props.thread.line}` : ''}
        </span>
        <span class="dev-scm-spacer" />
        <Show when={props.thread.outdated}>
          <Badge size="sm" variant="secondary">
            Outdated
          </Badge>
        </Show>
        <Badge size="sm" variant={props.thread.resolved ? 'success' : 'outline'}>
          {props.thread.resolved ? 'Resolved' : 'Unresolved'}
        </Badge>
      </div>
      <Show when={excerpt().some((row) => row.kind === 'hunk' || row.text.length > 0)}>
        <div class="dev-scm-diff" aria-label="Code under discussion">
          <For each={excerpt()}>
            {(row) => (
              <div
                class={cn('dev-scm-diff__line', {
                  'dev-scm-diff__line--add': row.kind === 'add',
                  'dev-scm-diff__line--delete': row.kind === 'delete',
                  'dev-scm-diff__line--hunk': row.kind === 'hunk',
                })}
              >
                <span class="dev-scm-diff__num">{row.oldLine ?? ''}</span>
                <span class="dev-scm-diff__num">{row.newLine ?? ''}</span>
                <span class="dev-scm-diff__marker">
                  {row.kind === 'add' ? '+' : row.kind === 'delete' ? '-' : ''}
                </span>
                <span class="dev-scm-diff__code">{row.text}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="dev-scm-card__body dev-scm-thread">
        <For each={props.thread.comments}>
          {(comment) => (
            <div class="dev-scm-thread__comment">
              <div class="flex min-w-0 flex-col gap-1">
                <span class="dev-scm-caption">
                  <Person actor={comment.author} /> {relativeTime(comment.createdAt, props.now)}
                </span>
                <RichText text={comment.body} />
              </div>
            </div>
          )}
        </For>
        <Show when={props.pr.state === 'open'}>
          <div class="dev-scm-thread__reply">
            <Input
              class="dev-scm-thread__reply-input"
              placeholder="Reply"
              aria-label={`Reply to the thread on ${props.thread.path}`}
              value={reply()}
              disabled={busy()}
              onInput={(event) => setReply(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <Show when={reply().trim().length > 0}>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy()}
                onClick={() => void send()}
              >
                Reply
              </Button>
            </Show>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy()}
              onClick={() => void resolve()}
            >
              {props.thread.resolved ? 'Unresolve conversation' : 'Resolve conversation'}
            </Button>
          </div>
        </Show>
      </div>
    </article>
  )
}

export function Conversation(props: {
  pr: PullRequestView
  items: readonly GitHubTimelineItem[] | undefined
  loading: boolean
  error?: string
  client: ScmClient
  viewer?: string
  now: number
  actions: AppActions
  onItem(item: GitHubTimelineItem): void
}): JSX.Element {
  const entries = createMemo(() => groupTimeline(props.items ?? []))
  const [comment, setComment] = createSignal('')
  const [posting, setPosting] = createSignal(false)
  const post = async () => {
    const body = comment().trim()
    if (!body) return
    setPosting(true)
    try {
      props.onItem(await props.client.comment(props.pr.id, body))
      setComment('')
    } catch (error) {
      props.actions.notify(errorText(error), 'error')
    } finally {
      setPosting(false)
    }
  }
  return (
    <div class="dev-scm-conversation">
      <article class="dev-scm-card" aria-label="Description">
        <div class="dev-scm-card__head">
          <Person actor={props.pr.author} agent={props.pr.authorIsAgent} />
          <span class="dev-scm-muted">opened {relativeTime(props.pr.createdAt, props.now)}</span>
          <Show when={props.pr.session}>
            {(session) => (
              <>
                <span class="dev-scm-spacer" />
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => props.actions.openSession(session())}
                >
                  From session “{session().title}”
                </Button>
              </>
            )}
          </Show>
        </div>
        <div class="dev-scm-card__body">
          <Show
            when={(props.pr.body ?? '').trim().length > 0}
            fallback={<p class="dev-scm-text dev-scm-muted">No description provided.</p>}
          >
            <RichText text={props.pr.body ?? ''} />
          </Show>
        </div>
      </article>

      <Show when={props.error}>
        <p class="dev-scm-caption" role="alert">
          The timeline could not be loaded: {props.error}
        </p>
      </Show>
      <Show when={props.loading && !props.items}>
        <p class="dev-scm-caption" role="status">
          Loading the conversation…
        </p>
      </Show>

      <For each={entries()}>
        {(entry) => (
          <Switch>
            <Match when={entry.kind === 'comment' && entry}>
              {(item) => (
                <article class="dev-scm-card">
                  <div class="dev-scm-card__head">
                    <Person actor={item().author} />
                    <span class="dev-scm-muted">
                      commented {relativeTime(item().createdAt, props.now)}
                    </span>
                  </div>
                  <div class="dev-scm-card__body">
                    <RichText text={item().body} />
                  </div>
                </article>
              )}
            </Match>
            <Match when={entry.kind === 'review' && entry}>
              {(item) => (
                <div class="dev-scm-event">
                  <EventMark
                    icon={(reviewMark[item().state] ?? reviewMark.commented!).icon}
                    tone={(reviewMark[item().state] ?? reviewMark.commented!).tone}
                    label={reviewText[item().state] ?? 'reviewed'}
                  />
                  <div class="dev-scm-event__body">
                    <span>
                      <Person actor={item().author} /> {reviewText[item().state] ?? 'reviewed'} ·{' '}
                      {relativeTime(item().createdAt, props.now)}
                    </span>
                    <Show when={item().body.trim().length > 0}>
                      <article class="dev-scm-card">
                        <div class="dev-scm-card__body">
                          <RichText text={item().body} />
                        </div>
                      </article>
                    </Show>
                  </div>
                </div>
              )}
            </Match>
            <Match when={entry.kind === 'push' && entry}>
              {(push) => (
                <div class="dev-scm-event">
                  <EventMark icon={GitCommitHorizontal} label="Pushed commits" />
                  <div class="dev-scm-event__body w-full">
                    <span>
                      {displayLogin(
                        push().commits[0]?.authorLogin ?? push().commits[0]?.authorName ?? 'Someone'
                      )}{' '}
                      pushed{' '}
                      {push().commits.length === 1
                        ? '1 commit'
                        : `${push().commits.length} commits`}{' '}
                      · {relativeTime(push().createdAt, props.now)}
                    </span>
                    <For each={push().commits}>
                      {(commit) => (
                        <div class="dev-scm-commit-line">
                          <span class="dev-scm-mono dev-scm-muted">{shortSha(commit.sha)}</span>
                          <span class="dev-scm-truncate">{commit.headline}</span>
                          <RollupChip state={commit.checks} />
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </Match>
            <Match when={entry.kind === 'thread' && entry}>
              {(thread) => (
                <ThreadCard
                  thread={thread()}
                  pr={props.pr}
                  client={props.client}
                  now={props.now}
                  actions={props.actions}
                  onChanged={props.onItem}
                />
              )}
            </Match>
            <Match when={entry.kind === 'event' && entry}>
              {(event) => (
                <div class="dev-scm-event">
                  <EventMark
                    icon={eventMark[event().event].icon}
                    tone={eventMark[event().event].tone}
                    label={eventText[event().event]}
                  />
                  <span>
                    <Person actor={event().actor} /> {eventText[event().event]}
                    <Show when={event().detail}>
                      {(detail) => (
                        <>
                          {' '}
                          <span class="dev-scm-mono">
                            {/^[0-9a-f]{40}$/.test(detail()) ? shortSha(detail()) : detail()}
                          </span>
                        </>
                      )}
                    </Show>{' '}
                    · {relativeTime(event().createdAt, props.now)}
                  </span>
                </div>
              )}
            </Match>
          </Switch>
        )}
      </For>

      <Show when={props.pr.state !== 'merged'}>
        <div class="dev-scm-composer">
          <Show when={props.viewer}>{(viewer) => <PersonAvatar login={viewer()} size="md" />}</Show>
          <div class="dev-scm-composer__field">
            <Textarea
              rows={3}
              class="w-full"
              placeholder="Leave a comment"
              aria-label="Comment"
              value={comment()}
              disabled={posting()}
              onInput={(event) => setComment(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void post()
                }
              }}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={posting() || comment().trim().length === 0}
              onClick={() => void post()}
            >
              Comment
            </Button>
          </div>
        </div>
      </Show>
    </div>
  )
}
