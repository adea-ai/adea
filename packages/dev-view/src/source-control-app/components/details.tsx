/*
 * The right-hand details panel on a pull request: reviewers, assignees, and
 * labels (each editable through a picker that applies one change at a
 * time), the Adea session that produced the branch, linked issues, and the
 * after-merge branch option.
 */
import type { GitHubActor, GitHubPullRequestSummary } from '@adea-ai/types/dev-runtime'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { Switch } from '@adea-ai/ui/components/ui/switch'
import { For, Show, createSignal, type JSX } from 'solid-js'

import { errorText, type ScmClient } from '../client'
import { displayLogin } from '../model/format'
import { hostNameOf, type PullRequestView, type Tone } from '../model/types'
import type { AppActions } from './actions'
import { Person } from './bits'
import { Picker, labelLoader, peopleLoader } from './picker'

type Field = 'reviewers' | 'assignees' | 'labels'

const reviewBadge: Record<
  string,
  { label: string; variant: 'success' | 'destructive' | 'outline' | 'secondary' }
> = {
  approved: { label: 'Approved', variant: 'success' },
  changes_requested: { label: 'Changes requested', variant: 'destructive' },
  commented: { label: 'Commented', variant: 'outline' },
  dismissed: { label: 'Dismissed', variant: 'secondary' },
  pending: { label: 'Pending', variant: 'secondary' },
}

const lifecycleTone: Record<string, Tone> = {
  active: 'success',
  ready: 'info',
  preparing: 'info',
  disconnected: 'warning',
  completed: 'neutral',
  failed: 'danger',
  cancelled: 'neutral',
}

export function DetailsPanel(props: {
  pr: PullRequestView
  client: ScmClient
  actions: AppActions
  deleteBranch: boolean
  onDeleteBranch(value: boolean): void
  onUpdated(summary: GitHubPullRequestSummary): void
}): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const editable = () => props.pr.state === 'open' && !busy()
  const change = async (field: Field, value: string, add: boolean) => {
    setBusy(true)
    try {
      const summary = await props.client.metadataUpdate(props.pr.id, {
        [field]: { add: add ? [value] : [], remove: add ? [] : [value] },
      })
      props.onUpdated(summary)
    } catch (error) {
      props.actions.notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }
  const reviewers = () => {
    const seen = new Map<string, { actor: GitHubActor; state: string }>()
    for (const review of props.pr.reviews)
      seen.set(review.actor.login, { actor: review.actor, state: review.state })
    for (const reviewer of props.pr.requestedReviewers)
      seen.set(reviewer.login, { actor: reviewer, state: 'requested' })
    return [...seen.values()]
  }
  return (
    <aside class="dev-scm__details" aria-label="Pull request details">
      <section class="dev-scm-details__section" aria-labelledby="dev-scm-details-reviewers">
        <div class="dev-scm-details__head">
          <h2 class="dev-scm-eyebrow" id="dev-scm-details-reviewers">
            Reviewers
          </h2>
          <Picker
            noun="reviewers"
            searchLabel="Search people"
            trigger="icon"
            selected={props.pr.requestedReviewers.map((reviewer) => reviewer.login)}
            disabled={!editable()}
            load={peopleLoader(
              (query) => props.client.assignableUsers(props.pr.repoId, query),
              props.pr.author?.login
            )}
            onToggle={(value, add) => void change('reviewers', value, add)}
          />
        </div>
        <Show
          when={reviewers().length > 0}
          fallback={<span class="dev-scm-caption">No reviewers.</span>}
        >
          <For each={reviewers()}>
            {(entry) => (
              <div class="dev-scm-person">
                <Person actor={entry.actor} />
                <span class="dev-scm-spacer" />
                <Show
                  when={reviewBadge[entry.state]}
                  fallback={
                    <Badge size="sm" variant="warning">
                      Requested
                    </Badge>
                  }
                >
                  {(badge) => (
                    <Badge size="sm" variant={badge().variant}>
                      {badge().label}
                    </Badge>
                  )}
                </Show>
              </div>
            )}
          </For>
        </Show>
      </section>

      <section class="dev-scm-details__section" aria-labelledby="dev-scm-details-assignees">
        <div class="dev-scm-details__head">
          <h2 class="dev-scm-eyebrow" id="dev-scm-details-assignees">
            Assignees
          </h2>
          <Picker
            noun="assignees"
            searchLabel="Search people"
            trigger="icon"
            selected={props.pr.assignees.map((assignee) => assignee.login)}
            disabled={!editable()}
            load={peopleLoader((query) => props.client.assignableUsers(props.pr.repoId, query))}
            onToggle={(value, add) => void change('assignees', value, add)}
          />
        </div>
        <Show
          when={props.pr.assignees.length > 0}
          fallback={<span class="dev-scm-caption">No one is assigned.</span>}
        >
          <For each={props.pr.assignees}>{(assignee) => <Person actor={assignee} />}</For>
        </Show>
      </section>

      <section class="dev-scm-details__section" aria-labelledby="dev-scm-details-labels">
        <div class="dev-scm-details__head">
          <h2 class="dev-scm-eyebrow" id="dev-scm-details-labels">
            Labels
          </h2>
          <Picker
            noun="labels"
            searchLabel="Filter labels"
            trigger="icon"
            selected={props.pr.labels}
            disabled={!editable()}
            load={labelLoader(() => props.client.labels(props.pr.repoId))}
            onToggle={(value, add) => void change('labels', value, add)}
          />
        </div>
        <Show
          when={props.pr.labels.length > 0}
          fallback={<span class="dev-scm-caption">No labels.</span>}
        >
          <div class="dev-scm-chips">
            <For each={props.pr.labels}>
              {(label) => (
                <Badge size="sm" variant="outline">
                  {label}
                </Badge>
              )}
            </For>
          </div>
        </Show>
      </section>

      <section class="dev-scm-details__section" aria-labelledby="dev-scm-details-session">
        <h2 class="dev-scm-eyebrow" id="dev-scm-details-session">
          Agent session
        </h2>
        <Show
          when={props.pr.session}
          fallback={
            <span class="dev-scm-caption">No Adea session has this branch checked out.</span>
          }
        >
          {(session) => (
            <div class="dev-scm-card">
              <div class="dev-scm-card__body flex flex-col gap-2">
                <div class="dev-scm-person">
                  <span class="dev-scm-truncate font-medium">{session().title}</span>
                  <span class="dev-scm-spacer" />
                  <StatusChip
                    tone={lifecycleTone[session().lifecycle] ?? 'unknown'}
                    label={session().lifecycle}
                  />
                </div>
                <span class="dev-scm-mono dev-scm-muted dev-scm-truncate">{props.pr.headRef}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => props.actions.openSession(session())}
                >
                  Open session
                </Button>
              </div>
            </div>
          )}
        </Show>
      </section>

      <section class="dev-scm-details__section" aria-labelledby="dev-scm-details-issues">
        <h2 class="dev-scm-eyebrow" id="dev-scm-details-issues">
          Linked issues
        </h2>
        <Show
          when={props.pr.linkedIssues.length > 0}
          fallback={<span class="dev-scm-caption">None.</span>}
        >
          <For each={props.pr.linkedIssues}>
            {(issue) => (
              <div class="dev-scm-person">
                <StatusChip
                  compact
                  tone={issue.state === 'open' ? 'success' : 'neutral'}
                  label={issue.state === 'open' ? 'Open' : 'Closed'}
                />
                <span class="dev-scm-truncate">{issue.title}</span>
                <span class="dev-scm-caption">#{issue.number}</span>
              </div>
            )}
          </For>
          <span class="dev-scm-caption">Closes when this merges.</span>
        </Show>
      </section>

      <Show when={props.pr.state === 'open' && !props.pr.crossRepository}>
        <section class="dev-scm-details__section" aria-labelledby="dev-scm-details-after">
          <h2 class="dev-scm-eyebrow" id="dev-scm-details-after">
            After merge
          </h2>
          <Switch
            checked={props.deleteBranch}
            onChange={props.onDeleteBranch}
            label={`Delete the branch on ${hostNameOf(props.pr.id)}`}
            description={`Removes ${displayLogin(props.pr.headRef)} unless it is protected. Local worktrees stay; clean them up in the Dev view.`}
          />
        </section>
      </Show>
    </aside>
  )
}
