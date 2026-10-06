/*
 * Project header and pull request inbox. Inbox groups open pull requests by
 * what each needs next; All open, Merged and Closed are flat lists. Filters
 * narrow by text, author, reviewer, label, and agent authorship. Each row's
 * single action routes or opens the matching confirmation.
 */
import type { GitHubPullRequestSummary } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Switch } from '@adea-ai/ui/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@adea-ai/ui/components/ui/tabs'
import { ChevronDown, GitBranch, GitPullRequest, GitPullRequestDraft, Plus } from 'lucide-solid'
import { For, Show, createMemo, createResource, createSignal, type JSX } from 'solid-js'

import { errorText } from '../client'
import { prRef, relativeTime, shortSha } from '../model/format'
import {
  classifyPullRequest,
  emptyInboxFilter,
  filterOptions,
  filterPullRequests,
  groupInbox,
  needsViewer,
  rowActionLabel,
  type InboxFilter,
} from '../model/inbox'
import { checksFacet, reviewFacet } from '../model/status'
import type { TreeProject } from '../model/tree'
import type { PullRequestView, RowAction } from '../model/types'
import type { SourceControlState } from '../state'
import type { AppActions } from './actions'
import { ChangeCounts, FacetChip, LoadingRows, Person, RollupChip, StateMessage } from './bits'

type Scope = 'inbox' | 'open' | 'merged' | 'closed'

const actionVariant: Record<RowAction, 'success' | 'outline' | 'ghost'> = {
  merge: 'success',
  review: 'outline',
  update_branch: 'outline',
  open: 'outline',
  open_session: 'ghost',
}

function PullRequestRow(props: {
  pr: PullRequestView
  action?: RowAction
  state: SourceControlState
  actions: AppActions
}): JSX.Element {
  const updated = () => {
    if (props.pr.state === 'merged' && props.pr.mergedAt)
      return `Merged ${relativeTime(props.pr.mergedAt, props.state.tick())}`
    if (props.pr.state === 'closed' && props.pr.closedAt)
      return `Closed ${relativeTime(props.pr.closedAt, props.state.tick())}`
    return `Updated ${relativeTime(props.pr.updatedAt, props.state.tick())}`
  }
  const run = () => {
    const pr = props.pr
    switch (props.action ?? 'open') {
      case 'open_session':
        if (pr.session) props.actions.openSession(pr.session)
        else props.actions.openPullRequest(pr)
        return
      case 'review':
        props.actions.openPullRequest(pr, 'files')
        return
      case 'merge':
        props.actions.requestMerge(pr)
        return
      case 'update_branch':
        props.actions.requestUpdateBranch(pr, 'merge')
        return
      default:
        props.actions.openPullRequest(pr)
    }
  }
  return (
    <div class="dev-scm-row" data-pr={props.pr.number}>
      <Show
        when={props.pr.draft}
        fallback={<GitPullRequest class="dev-scm-row__icon--open" aria-label="Open" />}
      >
        <GitPullRequestDraft class="dev-scm-row__icon--draft" aria-label="Draft" />
      </Show>
      <div class="dev-scm-row__main">
        {/* Quiet title text, like every other list row: the row's action
            button is its one coloured control. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="-ms-2 h-auto max-w-full justify-start"
          onClick={() => props.actions.openPullRequest(props.pr)}
        >
          <span class="dev-scm-truncate">{props.pr.title}</span>
          <span class="dev-scm-muted">{prRef(props.pr)}</span>
        </Button>
        <span class="dev-scm-row__meta">
          <Person actor={props.pr.author} agent={props.pr.authorIsAgent} />
          <span aria-hidden="true">·</span>
          <span class="dev-scm-mono dev-scm-truncate">{props.pr.headRef}</span>
          <span aria-hidden="true">·</span>
          <span class="whitespace-nowrap">{updated()}</span>
        </span>
      </div>
      <span class="dev-scm-row__facet">
        <FacetChip facet={checksFacet(props.pr.checks)} />
      </span>
      <span class="dev-scm-row__facet">
        <FacetChip facet={reviewFacet(props.pr)} />
      </span>
      <span class="dev-scm-row__numbers">
        <ChangeCounts additions={props.pr.additions} deletions={props.pr.deletions} />
      </span>
      <div class="dev-scm-row__action">
        <Show when={props.action}>
          {(action) => (
            <Button
              type="button"
              size="sm"
              variant={actionVariant[action()]}
              aria-label={`${rowActionLabel[action()]}: ${props.pr.title}`}
              onClick={run}
            >
              {rowActionLabel[action()]}
            </Button>
          )}
        </Show>
      </div>
    </div>
  )
}

function FilterMenu(props: {
  label: string
  value?: string
  options: readonly string[]
  onChange(value: string | undefined): void
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        as={Button}
        type="button"
        variant="outline"
        size="sm"
        disabled={props.options.length === 0}
      >
        {props.value ? `${props.label}: ${props.value}` : props.label}
        <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent hideArrow class="max-h-(--kb-popper-available-height) overflow-y-auto">
        <DropdownMenuRadioGroup
          value={props.value ?? ''}
          onChange={(value: unknown) =>
            props.onChange(value === '' || typeof value !== 'string' ? undefined : value)
          }
        >
          <DropdownMenuRadioItem value="" closeOnSelect>
            Any {props.label.toLowerCase()}
          </DropdownMenuRadioItem>
          <For each={props.options}>
            {(option) => (
              <DropdownMenuRadioItem value={option} closeOnSelect>
                {option}
              </DropdownMenuRadioItem>
            )}
          </For>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ProjectInbox(props: {
  project: TreeProject
  state: SourceControlState
  actions: AppActions
}): JSX.Element {
  const [scope, setScope] = createSignal<Scope>('inbox')
  const [filter, setFilter] = createSignal<InboxFilter>(emptyInboxFilter)
  const entry = () => props.state.pulls().get(props.project.repoId)
  const meta = () => props.state.repoMeta().get(props.project.repoId)
  const open = () => props.state.openPulls(props.project.repoId)

  const [history] = createResource(
    () =>
      scope() === 'merged' || scope() === 'closed'
        ? { repoId: props.project.repoId, state: scope() }
        : undefined,
    async (source) => {
      const page = await props.state.client.summaries(
        source.repoId,
        source.state as 'merged' | 'closed'
      )
      return page.items.map((pr: GitHubPullRequestSummary) => props.state.link(pr))
    }
  )

  const listed = createMemo(() =>
    filterPullRequests(
      scope() === 'merged' || scope() === 'closed' ? (history() ?? []) : open(),
      filter()
    )
  )
  const options = createMemo(() => filterOptions(open()))
  const groups = createMemo(() => groupInbox(listed(), (pr) => props.state.viewerFor(pr.id)))

  return (
    <>
      <div class="dev-scm-header">
        <div class="dev-scm-header__row">
          <h1 class="dev-scm-header__title">
            <span class="dev-scm-header__owner">{props.project.owner} / </span>
            {props.project.name}
          </h1>
          <Show when={meta()}>
            {(repository) => (
              <>
                <Badge variant="outline" size="sm">
                  <GitBranch aria-hidden="true" />
                  {repository().defaultBranch}
                </Badge>
                <Show when={repository().defaultBranchHead}>
                  {(head) => (
                    <>
                      <RollupChip state={head().checks} subject={repository().defaultBranch} />
                      <span class="dev-scm-mono dev-scm-muted">{shortSha(head().sha)}</span>
                    </>
                  )}
                </Show>
              </>
            )}
          </Show>
          <span class="dev-scm-spacer" />
          <Button type="button" onClick={() => props.actions.newPullRequest(props.project.repoId)}>
            <Plus aria-hidden="true" />
            New pull request
          </Button>
        </div>
      </div>

      <div class="dev-scm-toolbar">
        <Tabs value={scope()} onChange={(value) => setScope(value as Scope)}>
          <TabsList appearance="segmented" aria-label="Pull request scope">
            <TabsTrigger appearance="segmented" value="inbox">
              Inbox
            </TabsTrigger>
            <TabsTrigger appearance="segmented" value="open">
              All open
            </TabsTrigger>
            <TabsTrigger appearance="segmented" value="merged">
              Merged
            </TabsTrigger>
            <TabsTrigger appearance="segmented" value="closed">
              Closed
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          type="search"
          class="dev-scm-toolbar__filter"
          placeholder="Filter by title, branch or number"
          aria-label="Filter pull requests"
          value={filter().text}
          onInput={(event) =>
            setFilter((current) => ({ ...current, text: event.currentTarget.value }))
          }
        />
        <FilterMenu
          label="Author"
          {...(filter().author ? { value: filter().author } : {})}
          options={options().authors}
          onChange={(author) => setFilter((current) => ({ ...current, author }))}
        />
        <FilterMenu
          label="Reviewer"
          {...(filter().reviewer ? { value: filter().reviewer } : {})}
          options={options().reviewers}
          onChange={(reviewer) => setFilter((current) => ({ ...current, reviewer }))}
        />
        <FilterMenu
          label="Label"
          {...(filter().label ? { value: filter().label } : {})}
          options={options().labels}
          onChange={(label) => setFilter((current) => ({ ...current, label }))}
        />
        <span class="dev-scm-spacer" />
        <Switch
          checked={filter().agentsOnly}
          onChange={(agentsOnly: boolean) => setFilter((current) => ({ ...current, agentsOnly }))}
          label="Opened by agents only"
        />
      </div>

      <div class="dev-scm__scroll">
        <Show when={entry()?.error && scope() !== 'merged' && scope() !== 'closed'}>
          <StateMessage title="Pull requests could not be loaded" description={entry()?.error}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void props.state.loadRepo(props.project.repoId)}
            >
              Try again
            </Button>
          </StateMessage>
        </Show>
        <Show
          when={
            scope() === 'merged' || scope() === 'closed' ? !history.loading : entry() !== undefined
          }
          fallback={<LoadingRows label="Loading pull requests" />}
        >
          <Show when={history.error}>
            <StateMessage
              title="Pull requests could not be loaded"
              description={errorText(history.error)}
            />
          </Show>
          <Show
            when={listed().length > 0}
            fallback={
              <Show when={!entry()?.error}>
                <StateMessage
                  title={
                    filter().text ||
                    filter().author ||
                    filter().reviewer ||
                    filter().label ||
                    filter().agentsOnly
                      ? 'No pull requests match these filters'
                      : scope() === 'merged'
                        ? 'No merged pull requests'
                        : scope() === 'closed'
                          ? 'No closed pull requests'
                          : 'No open pull requests'
                  }
                  description={
                    scope() === 'inbox' || scope() === 'open'
                      ? 'Push a branch and open one to see it here.'
                      : undefined
                  }
                />
              </Show>
            }
          >
            <div class="dev-scm-inbox">
              <Show
                when={scope() === 'inbox'}
                fallback={
                  <div class="dev-scm-rows">
                    <For each={listed()}>
                      {(pr) => (
                        <PullRequestRow
                          pr={pr}
                          {...(pr.state === 'open'
                            ? {
                                action: classifyPullRequest(pr, props.state.viewerFor(pr.id))
                                  .action,
                              }
                            : {})}
                          state={props.state}
                          actions={props.actions}
                        />
                      )}
                    </For>
                  </div>
                }
              >
                <For each={groups()}>
                  {(group) => (
                    <section aria-labelledby={`dev-scm-group-${group.id}`}>
                      <div class="dev-scm-group__head">
                        <h2 class="dev-scm-group__label" id={`dev-scm-group-${group.id}`}>
                          {group.label}
                        </h2>
                        <Badge size="sm" variant="secondary">
                          {group.items.length}
                        </Badge>
                        <span class="dev-scm-caption">{group.hint}</span>
                      </div>
                      <div class="dev-scm-rows">
                        <For each={group.items}>
                          {(item) => (
                            <PullRequestRow
                              pr={item.pr}
                              action={item.action}
                              state={props.state}
                              actions={props.actions}
                            />
                          )}
                        </For>
                      </div>
                    </section>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </>
  )
}

/** Cross-project shortcuts: Needs you, and Ready to merge. */
export function ShortcutInbox(props: {
  id: 'needs_you' | 'ready'
  state: SourceControlState
  actions: AppActions
}): JSX.Element {
  const rows = createMemo(() =>
    props.state
      .everyOpen()
      .filter(({ pr }) =>
        props.id === 'ready'
          ? classifyPullRequest(pr, props.state.viewerFor(pr.id)).group === 'ready'
          : needsViewer(pr, props.state.viewerFor(pr.id))
      )
  )
  const byProject = createMemo(() => {
    const groups = new Map<string, { project: TreeProject; prs: PullRequestView[] }>()
    for (const { pr, project } of rows()) {
      const group = groups.get(project.key) ?? { project, prs: [] }
      group.prs.push(pr)
      groups.set(project.key, group)
    }
    return [...groups.values()]
  })
  return (
    <>
      <div class="dev-scm-header">
        <div class="dev-scm-header__row">
          <h1 class="dev-scm-header__title">
            {props.id === 'ready' ? 'Ready to merge' : 'Needs you'}
          </h1>
          <span class="dev-scm-caption">
            {props.id === 'ready'
              ? 'Approved, checks passing, up to date, across every project'
              : 'Reviews requested of you, and your pull requests that are ready or blocked'}
          </span>
        </div>
      </div>
      <div class={cn('dev-scm__scroll', 'mt-3')}>
        <Show
          when={props.state.syncedAt() !== undefined || rows().length > 0}
          fallback={<LoadingRows label="Loading pull requests" />}
        >
          <Show
            when={rows().length > 0}
            fallback={
              <StateMessage
                title={
                  props.id === 'ready' ? 'Nothing is ready to merge' : 'Nothing needs you right now'
                }
                description="Pull requests appear here as their state changes."
              />
            }
          >
            <div class="dev-scm-inbox">
              <For each={byProject()}>
                {(group) => (
                  <section aria-label={`${group.project.owner}/${group.project.name}`}>
                    <h2 class="dev-scm-section-project">
                      {group.project.owner} / {group.project.name}
                    </h2>
                    <div class="dev-scm-rows">
                      <For each={group.prs}>
                        {(pr) => (
                          <PullRequestRow
                            pr={pr}
                            action={classifyPullRequest(pr, props.state.viewerFor(pr.id)).action}
                            state={props.state}
                            actions={props.actions}
                          />
                        )}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </>
  )
}
