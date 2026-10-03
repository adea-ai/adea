/*
 * Pull request detail: the header, the four tabs, the merge dock under the
 * conversation, and the details panel (open by default on Conversation,
 * closed elsewhere, remembered per tab). After any mutation the pull request
 * is re-read and folded back into the inbox.
 */
import type { GitHubPullRequestSummary, GitHubTimelineItem } from '@adea-ai/types/dev-runtime'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@adea-ai/ui/components/ui/alert-dialog'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@adea-ai/ui/components/ui/tabs'
import { PanelRightClose, PanelRightOpen } from 'lucide-solid'
import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  type JSX,
} from 'solid-js'

import { errorText } from '../client'
import { mergeDock, preferredMethod } from '../model/merge-dock'
import type { PrTab } from '../model/persistence'
import { checksFailing } from '../model/status'
import { githubCapabilities, type PullRequestView } from '../model/types'
import type { SourceControlState } from '../state'
import type { AppActions } from './actions'
import { ChangeCounts, LoadingRows, Person, StateMessage } from './bits'
import { ChecksView, CommitsList } from './checks'
import { Conversation } from './conversation'
import { DetailsPanel } from './details'
import { FilesChanged } from './files'
import { MergeDockView } from './merge-dock'

type Thread = Extract<GitHubTimelineItem, { kind: 'thread' }>

const stateBadge: Record<
  string,
  { label: string; variant: 'success' | 'secondary' | 'info' | 'destructive' }
> = {
  open: { label: 'Open', variant: 'success' },
  draft: { label: 'Draft', variant: 'secondary' },
  merged: { label: 'Merged', variant: 'info' },
  closed: { label: 'Closed', variant: 'destructive' },
}

function tabCount(count: number): JSX.Element {
  return count > 0 ? (
    <Badge size="sm" variant="secondary">
      {count}
    </Badge>
  ) : null
}

export function PullRequestDetail(props: {
  pullRequestId: string
  repoId: string
  tab: PrTab
  revision: number
  state: SourceControlState
  actions: AppActions
  onTab(tab: PrTab): void
}): JSX.Element {
  const client = props.state.client
  const cached = () =>
    props.state.openPulls(props.repoId).find((pr) => pr.id === props.pullRequestId)
  const [busy, setBusy] = createSignal<string>()
  const [confirmClose, setConfirmClose] = createSignal(false)
  const [localRevision, setLocalRevision] = createSignal(0)

  const [summary, { mutate: setSummary }] = createResource(
    () => ({ id: props.pullRequestId, revision: props.revision + localRevision() }),
    async (source) => client.summary(source.id, source.revision > 0)
  )
  // A fresh read folds back into the inbox so the row matches the detail.
  createEffect(
    on(summary, (fresh) => {
      if (fresh) props.state.absorb(fresh)
    })
  )
  const pr = createMemo((): PullRequestView | undefined => {
    const fresh = summary()
    return fresh ? props.state.link(fresh) : cached()
  })

  const [timeline, { mutate: setTimeline, refetch: refetchTimeline }] = createResource(
    () => ({ id: props.pullRequestId, revision: props.revision + localRevision() }),
    async (source) => client.timeline(source.id)
  )
  const [commits] = createResource(
    () =>
      props.tab === 'commits' || props.tab === 'checks'
        ? { id: props.pullRequestId, head: pr()?.headSha }
        : undefined,
    async (source) => (await client.commits(source.id)).items
  )
  const [files] = createResource(
    () => (props.tab === 'files' ? { id: props.pullRequestId, head: pr()?.headSha } : undefined),
    async (source) => client.files(source.id)
  )

  const threads = createMemo(() =>
    (timeline() ?? []).filter((item): item is Thread => item.kind === 'thread')
  )
  const method = () => {
    const current = pr()
    return current
      ? preferredMethod(current.mergeMethods, props.state.preferences().mergeMethod)
      : undefined
  }
  const dock = createMemo(() => {
    const current = pr()
    return current
      ? mergeDock(current, props.state.viewer(), method(), githubCapabilities)
      : undefined
  })
  const detailsOpen = () => props.state.preferences().details[props.tab]
  const setDetailsOpen = (open: boolean) =>
    props.state.setPreferences((current) => ({
      ...current,
      details: { ...current.details, [props.tab]: open },
    }))

  createEffect(
    on(
      () => props.pullRequestId,
      () => {
        setBusy(undefined)
        setConfirmClose(false)
      },
      { defer: true }
    )
  )

  const absorb = (next: GitHubPullRequestSummary) => {
    setSummary(next)
    props.state.absorb(next)
  }

  const replaceItem = (item: GitHubTimelineItem) =>
    setTimeline((current) => {
      const list = current ?? []
      const exists = list.some((entry) => entry.id === item.id)
      return exists ? list.map((entry) => (entry.id === item.id ? item : entry)) : [...list, item]
    })

  async function run(label: string, task: () => Promise<unknown>, success?: string) {
    setBusy(label)
    try {
      await task()
      if (success) props.actions.notify(success, 'success')
    } catch (error) {
      props.actions.notify(errorText(error), 'error')
    } finally {
      setBusy(undefined)
      setLocalRevision((value) => value + 1)
    }
  }

  return (
    <Show
      when={pr()}
      fallback={
        <Show when={summary.error} fallback={<LoadingRows label="Loading the pull request" />}>
          <StateMessage
            title="The pull request could not be loaded"
            description={errorText(summary.error)}
          />
        </Show>
      }
    >
      {(current) => (
        <div class="dev-scm__body flex-1">
          <div class="dev-scm__main">
            <div class="dev-scm-header">
              <div class="dev-scm-pr__crumbs">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  class="h-auto"
                  onClick={() => props.state.setRoute({ view: 'inbox' })}
                >
                  {current().id.slice(3, current().id.indexOf('#'))}
                </Button>
                <span aria-hidden="true">/</span>
                <span>#{current().number}</span>
              </div>
              <div class="dev-scm-header__row">
                <h1 class="dev-scm-pr__title">
                  {current().title} <span class="dev-scm-pr__number">#{current().number}</span>
                </h1>
              </div>
              <div class="dev-scm-header__row">
                <Badge
                  size="sm"
                  variant={
                    stateBadge[
                      current().state === 'open' && current().draft ? 'draft' : current().state
                    ]!.variant
                  }
                >
                  {
                    stateBadge[
                      current().state === 'open' && current().draft ? 'draft' : current().state
                    ]!.label
                  }
                </Badge>
                <Person actor={current().author} agent={current().authorIsAgent} />
                <span class="dev-scm-caption">
                  wants to merge{' '}
                  {current().commitCount === 1 ? '1 commit' : `${current().commitCount} commits`}{' '}
                  into
                </span>
                <Badge size="sm" variant="outline">
                  <span class="dev-scm-mono">{current().baseRef}</span>
                </Badge>
                <span class="dev-scm-caption">from</span>
                <Badge size="sm" variant="outline">
                  <span class="dev-scm-mono">{current().headRef}</span>
                </Badge>
                <span class="dev-scm-spacer" />
                <ActionButton
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  tooltip={detailsOpen() ? 'Hide details panel' : 'Show details panel'}
                  aria-label={detailsOpen() ? 'Hide details panel' : 'Show details panel'}
                  aria-pressed={detailsOpen()}
                  onClick={() => setDetailsOpen(!detailsOpen())}
                >
                  <Show when={detailsOpen()} fallback={<PanelRightOpen aria-hidden="true" />}>
                    <PanelRightClose aria-hidden="true" />
                  </Show>
                </ActionButton>
              </div>
              <div class="dev-scm-pr__tabs">
                <Tabs value={props.tab} onChange={(value) => props.onTab(value as PrTab)}>
                  <TabsList aria-label="Pull request sections">
                    <TabsTrigger value="conversation">
                      Conversation{' '}
                      {tabCount(
                        (timeline() ?? []).filter(
                          (item) => item.kind === 'comment' || item.kind === 'thread'
                        ).length
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="commits">
                      Commits {tabCount(current().commitCount)}
                    </TabsTrigger>
                    <TabsTrigger value="checks">
                      Checks{' '}
                      <Show
                        when={checksFailing(current().checks)}
                        fallback={tabCount(current().checks.total)}
                      >
                        <Badge size="sm" variant="destructive">
                          {current().checks.failing} failing
                        </Badge>
                      </Show>
                    </TabsTrigger>
                    <TabsTrigger value="files">
                      Files changed {tabCount(current().changedFiles)}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <span class="dev-scm-spacer" />
                <ChangeCounts additions={current().additions} deletions={current().deletions} />
              </div>
            </div>

            <Switch>
              <Match when={props.tab === 'conversation'}>
                <div class="dev-scm__scroll">
                  <Conversation
                    pr={current()}
                    items={timeline()}
                    loading={timeline.loading}
                    {...(timeline.error ? { error: errorText(timeline.error) } : {})}
                    client={client}
                    {...(props.state.viewer() ? { viewer: props.state.viewer()! } : {})}
                    now={props.state.tick()}
                    actions={props.actions}
                    onItem={replaceItem}
                  />
                </div>
                <Show when={dock()}>
                  {(value) => (
                    <MergeDockView
                      pr={current()}
                      dock={value()}
                      {...(method() ? { method: method()! } : {})}
                      {...(busy() ? { busy: busy()! } : {})}
                      canDraft={githubCapabilities.draft}
                      onMethod={(next) =>
                        props.state.setPreferences((prefs) => ({ ...prefs, mergeMethod: next }))
                      }
                      onReview={() => props.onTab('files')}
                      onViewChecks={() => props.onTab('checks')}
                      onUpdateBranch={(strategy) =>
                        props.actions.requestUpdateBranch(current(), strategy)
                      }
                      onMerge={() => props.actions.requestMerge(current())}
                      onAutoMerge={(enabled) =>
                        void run(
                          'auto-merge',
                          async () =>
                            absorb(
                              await client.autoMerge(
                                current().id,
                                current().headSha,
                                enabled,
                                method()
                              )
                            ),
                          enabled ? 'Auto-merge enabled.' : 'Auto-merge cancelled.'
                        )
                      }
                      onDraft={(draft) =>
                        void run(
                          'draft',
                          () => client.update(current().id, { draft }),
                          draft ? 'Converted to a draft.' : 'Marked ready for review.'
                        )
                      }
                      onClose={() => setConfirmClose(true)}
                      onReopen={() =>
                        void run(
                          'reopen',
                          () => client.update(current().id, { state: 'open' }),
                          'Pull request reopened.'
                        )
                      }
                    />
                  )}
                </Show>
              </Match>
              <Match when={props.tab === 'commits'}>
                <div class="dev-scm__scroll">
                  <CommitsList
                    commits={commits()}
                    loading={commits.loading}
                    {...(commits.error ? { error: errorText(commits.error) } : {})}
                    now={props.state.tick()}
                  />
                </div>
              </Match>
              <Match when={props.tab === 'checks'}>
                <ChecksView
                  pr={current()}
                  commits={commits()}
                  client={client}
                  capabilities={githubCapabilities}
                  now={props.state.tick()}
                  actions={props.actions}
                />
              </Match>
              <Match when={props.tab === 'files'}>
                <FilesChanged
                  pr={current()}
                  files={files()}
                  loading={files.loading}
                  {...(files.error ? { error: errorText(files.error) } : {})}
                  threads={threads()}
                  client={client}
                  storage={props.state.storage}
                  {...(props.state.viewer() ? { viewer: props.state.viewer()! } : {})}
                  now={props.state.tick()}
                  layout={props.state.preferences().diffLayout}
                  actions={props.actions}
                  onLayout={(diffLayout) =>
                    props.state.setPreferences((prefs) => ({ ...prefs, diffLayout }))
                  }
                  onThread={replaceItem}
                  onSubmitted={() => {
                    void refetchTimeline()
                    setLocalRevision((value) => value + 1)
                  }}
                />
              </Match>
            </Switch>
          </div>
          <Show when={detailsOpen()}>
            <DetailsPanel
              pr={current()}
              client={client}
              actions={props.actions}
              deleteBranch={props.state.preferences().deleteBranch}
              onDeleteBranch={(deleteBranch) =>
                props.state.setPreferences((prefs) => ({ ...prefs, deleteBranch }))
              }
              onUpdated={absorb}
            />
          </Show>
          <AlertDialog open={confirmClose()} onOpenChange={setConfirmClose}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Close this pull request?</AlertDialogTitle>
                <AlertDialogDescription>
                  #{current().number} closes without merging. The branch stays, and you can reopen
                  it later.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel as={Button} type="button" variant="outline">
                  Keep it open
                </AlertDialogCancel>
                <AlertDialogAction
                  as={Button}
                  type="button"
                  variant="destructive"
                  onClick={() =>
                    void run(
                      'close',
                      () => client.update(current().id, { state: 'closed' }),
                      'Pull request closed.'
                    )
                  }
                >
                  Close pull request
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </Show>
  )
}
