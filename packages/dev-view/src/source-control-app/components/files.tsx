/*
 * Files changed: a filterable file tree, every changed file's diff in
 * unified or split layout, viewed tracking per head, existing review threads
 * in place, and pending review comments that stay local (and survive a
 * reload) until Submit review sends them with one verdict.
 */
import type { GitHubChangedFile, GitHubTimelineItem } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Checkbox } from '@adea-ai/ui/components/ui/checkbox'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@adea-ai/ui/components/ui/popover'
import { Progress } from '@adea-ai/ui/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@adea-ai/ui/components/ui/radio-group'
import { Tabs, TabsList, TabsTrigger } from '@adea-ai/ui/components/ui/tabs'
import { Textarea } from '@adea-ai/ui/components/ui/textarea'
import {
  CircleCheck,
  File,
  FileCode,
  FileCog,
  FileImage,
  FileBraces,
  FileText,
  MessageSquarePlus,
  Trash2,
} from 'lucide-solid'
import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'

import { errorText, type ScmClient } from '../client'
import {
  anchorKey,
  anchorOf,
  groupByDirectory,
  parsePatch,
  splitPath,
  splitRows,
  type DiffAnchor,
  type DiffRow,
} from '../model/diff'
import type { AppStorage, PendingComment, ReviewDraft } from '../model/persistence'
import { fileKind, type FileKind } from '../model/file-kind'
import { reviewCopy } from '../model/review'
import { viewerIsAuthor } from '../model/status'
import { hostNameOf, type PullRequestView } from '../model/types'
import type { AppActions } from './actions'
import { ChangeCounts, LoadingRows, StateMessage } from './bits'
import { ThreadCard } from './conversation'

type Thread = Extract<GitHubTimelineItem, { kind: 'thread' }>
type Composer = Readonly<{ path: string; anchor: DiffAnchor }>

let commentSequence = 0
const newCommentId = () => `c${Date.now().toString(36)}${(commentSequence += 1).toString(36)}`

function fileId(path: string): string {
  return `dev-scm-file-${path.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

const kindIcon: Record<FileKind, typeof File> = {
  code: FileCode,
  data: FileBraces,
  doc: FileText,
  image: FileImage,
  config: FileCog,
  other: File,
}

/** The changed file's type as an icon; decorative, the path names it. */
function FileKindIcon(props: { path: string }): JSX.Element {
  return (
    <Dynamic
      component={kindIcon[fileKind(props.path)]}
      class="size-4 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
  )
}

function LineNumber(props: {
  row: DiffRow | undefined
  side: 'left' | 'right'
  path: string
  commentable: boolean
  onComment(anchor: DiffAnchor): void
}): JSX.Element {
  const number = () => (props.side === 'left' ? props.row?.oldLine : props.row?.newLine)
  const anchor = () => {
    const row = props.row
    if (!row) return undefined
    const own = anchorOf(row)
    if (own && own.side === props.side) return own
    // Context lines can be commented from either side; GitHub anchors them right.
    if (row.kind === 'context' && row.newLine !== undefined)
      return { side: 'right' as const, line: row.newLine }
    return undefined
  }
  return (
    <span class="dev-scm-diff__num">
      <Show when={props.commentable && anchor() && number() !== undefined} fallback={number()}>
        <Button
          type="button"
          variant="ghost"
          size="2xs"
          aria-label={`Comment on ${props.path} ${props.side === 'left' ? 'old ' : ''}line ${number()}`}
          onClick={() => props.onComment(anchor()!)}
        >
          {number()}
        </Button>
      </Show>
    </span>
  )
}

function InlineAnnotations(props: {
  pr: PullRequestView
  path: string
  anchor: DiffAnchor
  threads: readonly Thread[]
  pending: readonly PendingComment[]
  composing: boolean
  client: ScmClient
  now: number
  actions: AppActions
  span: number
  onThread(thread: Thread): void
  onAdd(body: string): void
  onRemove(id: string): void
  onCancel(): void
}): JSX.Element {
  const [text, setText] = createSignal('')
  return (
    <Show when={props.threads.length > 0 || props.pending.length > 0 || props.composing}>
      <div class="dev-scm-diff__inline">
        <div class="flex flex-col gap-2">
          <For each={props.threads}>
            {(thread) => (
              <ThreadCard
                thread={thread}
                pr={props.pr}
                client={props.client}
                now={props.now}
                actions={props.actions}
                onChanged={props.onThread}
              />
            )}
          </For>
          <For each={props.pending}>
            {(comment) => (
              <div class="dev-scm-thread__comment">
                <Badge size="sm" variant="warning">
                  Pending
                </Badge>
                <p class="dev-scm-text flex-1">{comment.body}</p>
                <ActionButton
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  tooltip="Remove this pending comment"
                  aria-label="Remove pending comment"
                  onClick={() => props.onRemove(comment.id)}
                >
                  <Trash2 aria-hidden="true" />
                </ActionButton>
              </div>
            )}
          </For>
          <Show when={props.composing}>
            <div class="dev-scm-composer__field">
              <Textarea
                rows={3}
                class="w-full"
                autofocus
                placeholder="Add a review comment"
                aria-label={`Review comment on ${props.path} line ${props.anchor.line}`}
                value={text()}
                onInput={(event) => setText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') props.onCancel()
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && text().trim()) {
                    event.preventDefault()
                    props.onAdd(text().trim())
                    setText('')
                  }
                }}
              />
              <div class="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => props.onCancel()}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={text().trim().length === 0}
                  onClick={() => {
                    props.onAdd(text().trim())
                    setText('')
                  }}
                >
                  Add to review
                </Button>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}

function FileDiff(props: {
  file: GitHubChangedFile
  pr: PullRequestView
  layout: 'unified' | 'split'
  threads: readonly Thread[]
  pending: readonly PendingComment[]
  composer?: Composer
  client: ScmClient
  now: number
  actions: AppActions
  onComment(anchor: DiffAnchor): void
  onThread(thread: Thread): void
  onAdd(anchor: DiffAnchor, body: string): void
  onRemove(id: string): void
  onCancel(): void
}): JSX.Element {
  const rows = createMemo(() => (props.file.patch ? parsePatch(props.file.patch) : []))
  const split = createMemo(() => (props.layout === 'split' ? splitRows(rows()) : []))
  const commentable = () => props.pr.state === 'open'
  const annotationsFor = (anchor: DiffAnchor | undefined) => {
    if (!anchor) return undefined
    const key = anchorKey(anchor)
    const threads = props.threads.filter(
      (thread) =>
        !thread.outdated &&
        thread.line !== undefined &&
        anchorKey({ side: thread.side, line: thread.line }) === key
    )
    const pending = props.pending.filter((comment) => anchorKey(comment) === key)
    const composing =
      props.composer !== undefined &&
      props.composer.path === props.file.path &&
      anchorKey(props.composer.anchor) === key
    return { anchor, threads, pending, composing }
  }
  const annotate = (anchor: DiffAnchor | undefined) => {
    const found = annotationsFor(anchor)
    if (!found) return null
    return (
      <InlineAnnotations
        pr={props.pr}
        path={props.file.path}
        anchor={found.anchor}
        threads={found.threads}
        pending={found.pending}
        composing={found.composing}
        client={props.client}
        now={props.now}
        actions={props.actions}
        span={props.layout === 'split' ? 6 : 4}
        onThread={props.onThread}
        onAdd={(body) => props.onAdd(found.anchor, body)}
        onRemove={props.onRemove}
        onCancel={props.onCancel}
      />
    )
  }
  return (
    <Show
      when={props.file.patch}
      fallback={
        <p class="dev-scm-diff__empty">
          {props.file.status === 'renamed' && props.file.additions + props.file.deletions === 0
            ? 'Renamed without content changes.'
            : `${hostNameOf(props.pr.id)} does not show this diff (binary or too large).`}
        </p>
      }
    >
      <div
        class={cn('dev-scm-diff', { 'dev-scm-diff--split': props.layout === 'split' })}
        role="group"
        aria-label={`Diff for ${props.file.path}`}
      >
        <Show
          when={props.layout === 'split'}
          fallback={
            <For each={rows()}>
              {(row) => (
                <>
                  <div
                    class={cn('dev-scm-diff__line', {
                      'dev-scm-diff__line--add': row.kind === 'add',
                      'dev-scm-diff__line--delete': row.kind === 'delete',
                      'dev-scm-diff__line--hunk': row.kind === 'hunk' || row.kind === 'meta',
                    })}
                  >
                    <LineNumber
                      row={row}
                      side="left"
                      path={props.file.path}
                      commentable={commentable() && row.kind === 'delete'}
                      onComment={props.onComment}
                    />
                    <LineNumber
                      row={row}
                      side="right"
                      path={props.file.path}
                      commentable={commentable() && row.kind !== 'delete'}
                      onComment={props.onComment}
                    />
                    <span class="dev-scm-diff__marker" aria-hidden="true">
                      {row.kind === 'add' ? '+' : row.kind === 'delete' ? '-' : ''}
                    </span>
                    <span class="dev-scm-diff__code">{row.text}</span>
                  </div>
                  {annotate(anchorOf(row))}
                </>
              )}
            </For>
          }
        >
          <For each={split()}>
            {(row) => (
              <Show
                when={row.kind === 'pair' && row}
                fallback={
                  <div class="dev-scm-diff__line dev-scm-diff__line--hunk">
                    <span />
                    <span />
                    <span class="dev-scm-diff__code">{(row as { text: string }).text}</span>
                  </div>
                }
              >
                {(pair) => (
                  <>
                    <div class="dev-scm-diff__line">
                      <LineNumber
                        row={pair().left}
                        side="left"
                        path={props.file.path}
                        commentable={commentable() && pair().left?.kind === 'delete'}
                        onComment={props.onComment}
                      />
                      <span
                        class={cn('dev-scm-diff__marker', {
                          'dev-scm-diff__cell--delete': pair().left?.kind === 'delete',
                        })}
                        aria-hidden="true"
                      >
                        {pair().left?.kind === 'delete' ? '-' : ''}
                      </span>
                      <span
                        class={cn('dev-scm-diff__code', {
                          'dev-scm-diff__cell--delete': pair().left?.kind === 'delete',
                        })}
                      >
                        {pair().left?.text ?? ''}
                      </span>
                      <LineNumber
                        row={pair().right}
                        side="right"
                        path={props.file.path}
                        commentable={commentable() && pair().right !== undefined}
                        onComment={props.onComment}
                      />
                      <span
                        class={cn('dev-scm-diff__marker', {
                          'dev-scm-diff__cell--add': pair().right?.kind === 'add',
                        })}
                        aria-hidden="true"
                      >
                        {pair().right?.kind === 'add' ? '+' : ''}
                      </span>
                      <span
                        class={cn('dev-scm-diff__code', {
                          'dev-scm-diff__cell--add': pair().right?.kind === 'add',
                        })}
                      >
                        {pair().right?.text ?? ''}
                      </span>
                    </div>
                    {annotate(pair().left?.kind === 'delete' ? anchorOf(pair().left!) : undefined)}
                    {annotate(pair().right ? anchorOf(pair().right!) : undefined)}
                  </>
                )}
              </Show>
            )}
          </For>
        </Show>
      </div>
    </Show>
  )
}

export function FilesChanged(props: {
  pr: PullRequestView
  files: readonly GitHubChangedFile[] | undefined
  loading: boolean
  error?: string
  threads: readonly Thread[]
  client: ScmClient
  storage: AppStorage
  viewer?: string
  /** The provider has a blocking request-changes verdict. */
  canRequestChanges: boolean
  now: number
  layout: 'unified' | 'split'
  actions: AppActions
  onLayout(layout: 'unified' | 'split'): void
  onThread(thread: Thread): void
  onSubmitted(item: GitHubTimelineItem): void
}): JSX.Element {
  const [filter, setFilter] = createSignal('')
  const [viewed, setViewed] = createSignal<ReadonlySet<string>>(new Set())
  const [draft, setDraft] = createSignal<ReviewDraft>({
    headSha: props.pr.headSha,
    body: '',
    verdict: 'comment',
    comments: [],
  })
  const [composer, setComposer] = createSignal<Composer>()
  const [reviewOpen, setReviewOpen] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)

  createEffect(
    on(
      () => [props.pr.id, props.pr.headSha] as const,
      ([id, headSha]) => {
        setViewed(props.storage.loadViewed(id, headSha))
        setDraft(
          props.storage.loadDraft(id) ?? { headSha, body: '', verdict: 'comment', comments: [] }
        )
      }
    )
  )

  const updateDraft = (change: (current: ReviewDraft) => ReviewDraft) => {
    const next = change(draft())
    setDraft(next)
    props.storage.saveDraft(props.pr.id, next)
  }
  const toggleViewed = (path: string, value: boolean) => {
    const next = new Set(viewed())
    if (value) next.add(path)
    else next.delete(path)
    setViewed(next)
    props.storage.saveViewed(props.pr.id, props.pr.headSha, next)
  }

  const visible = createMemo(() => {
    const needle = filter().trim().toLowerCase()
    return (props.files ?? []).filter((file) => !needle || file.path.toLowerCase().includes(needle))
  })
  const groups = createMemo(() => groupByDirectory(visible()))
  const totals = createMemo(() => {
    let additions = 0
    let deletions = 0
    for (const file of props.files ?? []) {
      additions += file.additions
      deletions += file.deletions
    }
    return { additions, deletions }
  })
  const viewedCount = () => (props.files ?? []).filter((file) => viewed().has(file.path)).length
  const threadsFor = (path: string) => props.threads.filter((thread) => thread.path === path)
  const own = () => viewerIsAuthor(props.pr, props.viewer)
  const copy = createMemo(() => reviewCopy(props.pr, props.viewer))
  /** The verdict to send: your own pull request only takes comments, and a
   *  stored request-changes draft falls back to a comment where the
   *  provider has no such verdict. */
  const verdict = () => {
    const chosen = draft().verdict
    if (own()) return 'comment'
    return chosen === 'request_changes' && !props.canRequestChanges ? 'comment' : chosen
  }
  const draftStale = () => draft().comments.length > 0 && draft().headSha !== props.pr.headSha

  const submit = async () => {
    const current = draft()
    setSubmitting(true)
    try {
      const item = await props.client.submitReview(
        props.pr.id,
        props.pr.headSha,
        verdict(),
        current.body.trim(),
        current.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: comment.side,
          ...(comment.startLine !== undefined ? { startLine: comment.startLine } : {}),
          body: comment.body,
        }))
      )
      updateDraft(() => ({ headSha: props.pr.headSha, body: '', verdict: 'comment', comments: [] }))
      setReviewOpen(false)
      props.actions.notify('Review submitted.', 'success')
      props.onSubmitted(item)
    } catch (error) {
      props.actions.notify(errorText(error), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="dev-scm-toolbar">
        <ChangeCounts additions={totals().additions} deletions={totals().deletions} />
        <span class="dev-scm-caption">
          {viewedCount()} of {(props.files ?? []).length} files viewed
        </span>
        <Progress
          class="w-24"
          value={viewedCount()}
          maxValue={Math.max(1, (props.files ?? []).length)}
          hideValue
          aria-label={`${viewedCount()} of ${(props.files ?? []).length} files viewed`}
        />
        <span class="dev-scm-spacer" />
        <Tabs
          value={props.layout}
          onChange={(value) => props.onLayout(value as 'unified' | 'split')}
        >
          <TabsList appearance="segmented" aria-label="Diff layout">
            <TabsTrigger appearance="segmented" value="unified">
              Unified
            </TabsTrigger>
            <TabsTrigger appearance="segmented" value="split">
              Split
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Show when={props.pr.state === 'open'}>
          <Popover open={reviewOpen()} onOpenChange={setReviewOpen} placement="bottom-end">
            <PopoverTrigger as={Button} type="button" variant="secondary" size="sm">
              Review changes
              <Show when={draft().comments.length > 0}>
                <Badge size="sm" variant="default">
                  {draft().comments.length}
                </Badge>
              </Show>
            </PopoverTrigger>
            <PopoverContent hideArrow aria-label="Finish your review">
              <div class="dev-scm-form">
                <h2 class="dev-scm-group__label">Finish your review</h2>
                <p class="dev-scm-caption">{copy().status}</p>
                <Show when={draftStale()}>
                  <p class="dev-scm-caption" role="alert">
                    The branch moved since these comments were written. Check their lines before
                    submitting.
                  </p>
                </Show>
                <Textarea
                  rows={3}
                  aria-label="Review summary"
                  placeholder="Leave a summary"
                  value={draft().body}
                  onInput={(event) => {
                    const body = event.currentTarget.value
                    updateDraft((current) => ({ ...current, body }))
                  }}
                />
                <RadioGroup
                  value={verdict()}
                  onChange={(value) =>
                    updateDraft((current) => ({
                      ...current,
                      verdict: value as ReviewDraft['verdict'],
                    }))
                  }
                  aria-label="Review verdict"
                >
                  <RadioGroupItem value="comment" label="Comment" description={copy().comment} />
                  <RadioGroupItem
                    value="approve"
                    label="Approve"
                    description={copy().approve}
                    disabled={own()}
                  />
                  <Show when={props.canRequestChanges}>
                    <RadioGroupItem
                      value="request_changes"
                      label="Request changes"
                      description={copy().requestChanges}
                      disabled={own()}
                    />
                  </Show>
                </RadioGroup>
                <div class="dev-scm-form__footer">
                  <span class="dev-scm-caption flex-1">
                    {draft().comments.length === 1
                      ? '1 pending comment'
                      : `${draft().comments.length} pending comments`}
                  </span>
                  <Button type="button" variant="ghost" onClick={() => setReviewOpen(false)}>
                    Cancel
                  </Button>
                  <ActionButton
                    type="button"
                    busy={submitting()}
                    busyLabel="Submitting"
                    disabled={
                      submitting() ||
                      (verdict() === 'comment' &&
                        draft().body.trim().length === 0 &&
                        draft().comments.length === 0) ||
                      (verdict() === 'request_changes' && draft().body.trim().length === 0)
                    }
                    onClick={() => void submit()}
                  >
                    Submit review
                  </ActionButton>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </Show>
      </div>
      <Show when={props.error}>
        <StateMessage title="Changed files could not be loaded" description={props.error} />
      </Show>
      <Show
        when={!props.loading || props.files}
        fallback={<LoadingRows label="Loading changed files" />}
      >
        <div class="dev-scm-files">
          <nav class="dev-scm-files__nav" aria-label="Changed files">
            <Input
              type="search"
              placeholder="Filter changed files"
              aria-label="Filter changed files"
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
            />
            <For each={groups()}>
              {(group) => (
                <>
                  <Show when={group.dir}>
                    <p class="dev-scm-files__dir">{group.dir}</p>
                  </Show>
                  <For each={group.files}>
                    {(file) => (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        class="w-full justify-between"
                        aria-label={`${file.path}${viewed().has(file.path) ? ', viewed' : ''}`}
                        onClick={() =>
                          document
                            .getElementById(fileId(file.path))
                            ?.scrollIntoView({ block: 'start' })
                        }
                      >
                        <span class="dev-scm-files__name">
                          <Show
                            when={viewed().has(file.path)}
                            fallback={<FileKindIcon path={file.path} />}
                          >
                            <CircleCheck class="size-4 shrink-0 text-success" aria-hidden="true" />
                          </Show>
                          <span
                            class={cn('dev-scm-truncate', {
                              'dev-scm-muted': viewed().has(file.path),
                            })}
                          >
                            {splitPath(file.path).name}
                          </span>
                        </span>
                        <ChangeCounts
                          additions={file.additions}
                          deletions={file.deletions}
                          muted={viewed().has(file.path)}
                        />
                      </Button>
                    )}
                  </For>
                </>
              )}
            </For>
          </nav>
          <div class="dev-scm-files__list">
            <Show
              when={(props.files ?? []).length > 0}
              fallback={<StateMessage title="No files changed" />}
            >
              <For each={visible()}>
                {(file) => (
                  <article class="dev-scm-card" id={fileId(file.path)} aria-label={file.path}>
                    <div class="dev-scm-card__head dev-scm-file__head">
                      <FileKindIcon path={file.path} />
                      <span class="dev-scm-mono dev-scm-truncate">
                        {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                      </span>
                      <Show when={threadsFor(file.path).length > 0}>
                        <Badge size="sm" variant="outline">
                          {threadsFor(file.path).length === 1
                            ? '1 thread'
                            : `${threadsFor(file.path).length} threads`}
                        </Badge>
                      </Show>
                      <span class="dev-scm-spacer" />
                      <ChangeCounts additions={file.additions} deletions={file.deletions} />
                      <Show when={props.pr.state === 'open'}>
                        <ActionButton
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          tooltip="Comment on the first changed line"
                          aria-label={`Comment on ${file.path}`}
                          disabled={!file.patch}
                          onClick={() => {
                            const first = parsePatch(file.patch ?? '')
                              .map(anchorOf)
                              .find((anchor) => anchor !== undefined)
                            if (first) setComposer({ path: file.path, anchor: first })
                          }}
                        >
                          <MessageSquarePlus aria-hidden="true" />
                        </ActionButton>
                      </Show>
                      <Checkbox
                        checked={viewed().has(file.path)}
                        onChange={(value: boolean) => toggleViewed(file.path, value)}
                        label="Viewed"
                      />
                    </div>
                    <Show when={!viewed().has(file.path)}>
                      <FileDiff
                        file={file}
                        pr={props.pr}
                        layout={props.layout}
                        threads={threadsFor(file.path)}
                        pending={draft().comments.filter((comment) => comment.path === file.path)}
                        {...(composer() ? { composer: composer()! } : {})}
                        client={props.client}
                        now={props.now}
                        actions={props.actions}
                        onComment={(anchor) => setComposer({ path: file.path, anchor })}
                        onThread={props.onThread}
                        onAdd={(anchor, body) => {
                          updateDraft((current) => ({
                            ...current,
                            headSha: props.pr.headSha,
                            comments: [
                              ...current.comments,
                              {
                                id: newCommentId(),
                                path: file.path,
                                line: anchor.line,
                                side: anchor.side,
                                body,
                              },
                            ],
                          }))
                          setComposer(undefined)
                        }}
                        onRemove={(id) =>
                          updateDraft((current) => ({
                            ...current,
                            comments: current.comments.filter((comment) => comment.id !== id),
                          }))
                        }
                        onCancel={() => setComposer(undefined)}
                      />
                    </Show>
                  </article>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
