/*
 * The merge dock, pinned under the conversation: reviews, checks, and branch
 * status rows, then the merge control with its method menu, and draft/close.
 * Merge, update branch, and close are confirmed by the app's dialogs; the
 * busy state is the only optimistic thing here — results are re-read.
 */
import type { GitHubMergeMethod } from '@adea-ai/types/dev-runtime'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ButtonGroup } from '@adea-ai/ui/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { ChevronDown } from 'lucide-solid'
import { For, Show, type JSX } from 'solid-js'

import { mergeMethodLabel, type MergeDock } from '../model/merge-dock'
import type { PullRequestView } from '../model/types'
import { FacetChip } from './bits'

export function MergeDockView(props: {
  pr: PullRequestView
  dock: MergeDock
  method?: GitHubMergeMethod
  busy?: string
  canDraft: boolean
  /** How this provider can update a branch; the first is the default. */
  updateMethods: readonly ('merge' | 'rebase')[]
  onMethod(method: GitHubMergeMethod): void
  onReview(): void
  onViewChecks(): void
  onUpdateBranch(method: 'merge' | 'rebase'): void
  onMerge(): void
  onAutoMerge(enabled: boolean): void
  onDraft(draft: boolean): void
  onClose(): void
  onReopen(): void
}): JSX.Element {
  const merge = () => props.dock.merge
  const methods = () => props.pr.mergeMethods
  return (
    <section class="dev-scm-dock" aria-label="Merge status">
      <div class="dev-scm-dock__row">
        <FacetChip facet={props.dock.reviews} />
        <span class="dev-scm-caption dev-scm-truncate dev-scm-dock__detail">
          {props.pr.reviews.length > 0
            ? props.pr.reviews
                .filter(
                  (review) => review.state === 'approved' || review.state === 'changes_requested'
                )
                .map(
                  (review) =>
                    `${review.actor.login} ${review.state === 'approved' ? 'approved' : 'requested changes'}`
                )
                .join(', ') || 'No approvals yet.'
            : props.pr.requestedReviewers.length > 0
              ? `Waiting on ${props.pr.requestedReviewers.map((reviewer) => reviewer.login).join(', ')}.`
              : 'No reviews yet.'}
        </span>
        <Show when={props.dock.reviews.canReview}>
          <Button type="button" variant="outline" size="sm" onClick={() => props.onReview()}>
            Review changes
          </Button>
        </Show>
      </div>
      <div class="dev-scm-dock__row">
        <FacetChip facet={props.dock.checks} />
        <span class="dev-scm-caption dev-scm-truncate dev-scm-dock__detail">
          {props.pr.checks.skipped > 0 ? `${props.pr.checks.skipped} skipped.` : ''}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => props.onViewChecks()}>
          View checks
        </Button>
      </div>
      <div class="dev-scm-dock__row">
        <FacetChip facet={props.dock.branch} />
        <span class="dev-scm-caption dev-scm-truncate dev-scm-dock__detail">
          {props.dock.branch.canUpdate
            ? 'No conflicts. Updating re-runs checks on the new head.'
            : ''}
        </span>
        <Show when={props.dock.branch.canUpdate}>
          <ButtonGroup label="Update branch">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={props.busy !== undefined}
              onClick={() => props.onUpdateBranch(props.updateMethods[0] ?? 'merge')}
            >
              Update branch
            </Button>
            <Show when={props.updateMethods.length > 1}>
              <DropdownMenu>
                <DropdownMenuTrigger
                  as={ActionButton}
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  tooltip="Choose merge or rebase"
                  aria-label="Choose merge or rebase"
                  disabled={props.busy !== undefined}
                >
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent hideArrow placement="bottom-end">
                  <DropdownMenuItem onSelect={() => props.onUpdateBranch('merge')}>
                    Update with a merge commit
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => props.onUpdateBranch('rebase')}>
                    Update with a rebase
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Show>
          </ButtonGroup>
        </Show>
      </div>
      <div class="dev-scm-dock__actions">
        <Show
          when={merge().kind === 'auto_enabled'}
          fallback={
            <ButtonGroup label="Merge">
              <ActionButton
                type="button"
                variant="default"
                size="md"
                busy={props.busy === 'merge'}
                busyLabel="Merging"
                disabled={merge().kind === 'disabled' || props.busy !== undefined}
                onClick={() =>
                  merge().kind === 'merge_when_ready' ? props.onAutoMerge(true) : props.onMerge()
                }
              >
                {merge().label}
              </ActionButton>
              <Show when={methods().length > 1 && merge().kind !== 'disabled'}>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    as={ActionButton}
                    type="button"
                    variant="default"
                    size="icon-md"
                    tooltip="Choose merge method"
                    aria-label="Choose merge method"
                    disabled={props.busy !== undefined}
                  >
                    <ChevronDown aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent hideArrow placement="top-start">
                    <DropdownMenuRadioGroup
                      value={props.method ?? ''}
                      onChange={(value) => props.onMethod(value as GitHubMergeMethod)}
                    >
                      <For each={methods()}>
                        {(method) => (
                          <DropdownMenuRadioItem value={method} closeOnSelect>
                            {mergeMethodLabel[method]}
                          </DropdownMenuRadioItem>
                        )}
                      </For>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </Show>
            </ButtonGroup>
          }
        >
          <span class="dev-scm-person">
            <FacetChip facet={{ tone: 'info', label: merge().label }} />
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.busy !== undefined}
            onClick={() => props.onAutoMerge(false)}
          >
            Cancel auto-merge
          </Button>
        </Show>
        <span class="dev-scm-caption">{merge().helper}</span>
        <span class="dev-scm-spacer" />
        <Show when={props.pr.state === 'open' && props.canDraft}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.busy !== undefined}
            onClick={() => props.onDraft(!props.pr.draft)}
          >
            {props.pr.draft ? 'Ready for review' : 'Convert to draft'}
          </Button>
        </Show>
        <Show
          when={props.pr.state === 'open'}
          fallback={
            <Show when={props.pr.state === 'closed'}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={props.busy !== undefined}
                onClick={() => props.onReopen()}
              >
                Reopen pull request
              </Button>
            </Show>
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.busy !== undefined}
            onClick={() => props.onClose()}
          >
            Close pull request
          </Button>
        </Show>
      </div>
    </section>
  )
}
