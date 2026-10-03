/*
 * Left sidebar: the two cross-project shortcuts, then GitHub owners with the
 * Adea projects whose repository lives there, each with its default-branch
 * CI state and open pull request count, archived projects collapsed at the
 * bottom, and Connect account in the footer. It shares the Dev view's
 * contextual sidebar frame, so the top bar's toggle and the drawer behave
 * the same.
 */
import { cn } from '@adea-ai/app-ui/lib/utils'
import {
  SidebarNav,
  SidebarNavContent,
  SidebarNavFooter,
  SidebarNavHeader,
  SidebarNavItem,
  SidebarNavSection,
  SidebarNavTitle,
} from '@adea-ai/ui/components/layout/sidebar-nav'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { GitMerge, Inbox, Plus } from 'lucide-solid'
import { For, Show, createSignal, type JSX } from 'solid-js'

import { monogram, type TreeProject } from '../model/tree'
import type { Tone } from '../model/types'
import type { SourceControlState } from '../state'

const ciTone: Record<string, Tone> = {
  success: 'success',
  failure: 'danger',
  pending: 'info',
  none: 'unknown',
}
const ciWord: Record<string, string> = {
  success: 'is passing',
  failure: 'is failing',
  pending: 'is running',
  none: 'has no checks',
}

function ProjectRow(props: { row: TreeProject; state: SourceControlState }): JSX.Element {
  const selected = () => {
    const current = props.state.selection()
    return current?.kind === 'project' && current.repoId === props.row.repoId
  }
  const count = () =>
    props.row.openCount === undefined
      ? undefined
      : `${props.row.openCount}${props.row.openCountMore ? '+' : ''}`
  return (
    <SidebarNavItem
      as="button"
      type="button"
      nested
      active={selected()}
      aria-current={selected() ? 'page' : undefined}
      title={
        props.row.projectName === props.row.name ? undefined : `Project ${props.row.projectName}`
      }
      onClick={() =>
        props.state.select({
          kind: 'project',
          repoId: props.row.repoId,
          projectId: props.row.projectId,
        })
      }
      data-repo-id={props.row.repoId}
    >
      <StatusChip
        compact
        tone={props.row.ci ? (ciTone[props.row.ci] ?? 'unknown') : 'unknown'}
        label={
          props.row.ci ? `Default branch ${ciWord[props.row.ci]}` : 'Default branch status unknown'
        }
      />
      <span class="dev-scm-truncate">{props.row.name}</span>
      <Show when={count()}>
        {(value) => (
          <span class="dev-scm-count" aria-label={`${value()} open pull requests`}>
            {value()}
          </span>
        )}
      </Show>
    </SidebarNavItem>
  )
}

export function SourceControlSidebar(props: {
  state: SourceControlState
  open: boolean
  onConnect(): void
}): JSX.Element {
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())
  const [archivedOpen, setArchivedOpen] = createSignal(false)
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const shortcutActive = (id: 'needs_you' | 'ready') => {
    const current = props.state.selection()
    return current?.kind === 'shortcut' && current.id === id
  }

  return (
    <div class={cn('dev-sidebar', { 'dev-sidebar--open': props.open })}>
      <SidebarNav as="aside" class="h-full w-full" aria-label="Accounts and projects">
        <SidebarNavHeader>
          <SidebarNavTitle as="h2">Source control</SidebarNavTitle>
        </SidebarNavHeader>
        <SidebarNavContent>
          <nav class="flex flex-col gap-1" aria-label="Pull request shortcuts">
            <SidebarNavItem
              as="button"
              type="button"
              active={shortcutActive('needs_you')}
              aria-current={shortcutActive('needs_you') ? 'page' : undefined}
              onClick={() => props.state.select({ kind: 'shortcut', id: 'needs_you' })}
              trailing={
                <Badge
                  size="sm"
                  variant={props.state.shortcutCounts().needsYou > 0 ? 'default' : 'secondary'}
                >
                  {props.state.shortcutCounts().needsYou}
                </Badge>
              }
            >
              <Inbox aria-hidden="true" />
              <span>Needs you</span>
            </SidebarNavItem>
            <SidebarNavItem
              as="button"
              type="button"
              active={shortcutActive('ready')}
              aria-current={shortcutActive('ready') ? 'page' : undefined}
              onClick={() => props.state.select({ kind: 'shortcut', id: 'ready' })}
              trailing={
                <Badge size="sm" variant="secondary">
                  {props.state.shortcutCounts().ready}
                </Badge>
              }
            >
              <GitMerge aria-hidden="true" />
              <span>Ready to merge</span>
            </SidebarNavItem>
          </nav>
          <nav class="mt-3 flex flex-col gap-3" aria-label="Accounts and projects">
            <Show
              when={props.state.tree().owners.length > 0}
              fallback={
                <Show when={props.state.catalogLoaded()}>
                  <EmptyDescription>
                    No projects with a GitHub or GitLab repository yet. Add one in the Dev view.
                  </EmptyDescription>
                </Show>
              }
            >
              <For each={props.state.tree().owners}>
                {(owner) => (
                  <SidebarNavSection
                    label={owner.owner}
                    headingAs="h3"
                    collapsible
                    open={!collapsed().has(owner.key)}
                    onOpenChange={() => toggle(owner.key)}
                    action={
                      <span class="dev-scm-tree__owner" aria-hidden="true">
                        <span class="dev-scm-mark">{monogram(owner.owner)}</span>
                        <span class="dev-scm-provider">{owner.providerName}</span>
                      </span>
                    }
                  >
                    <For each={owner.projects}>
                      {(row) => <ProjectRow row={row} state={props.state} />}
                    </For>
                  </SidebarNavSection>
                )}
              </For>
            </Show>
            <Show when={props.state.tree().archived.length > 0}>
              <SidebarNavSection
                label="Archived projects"
                headingAs="h3"
                collapsible
                open={archivedOpen()}
                onOpenChange={setArchivedOpen}
                count={props.state.tree().archived.length}
              >
                <For each={props.state.tree().archived}>
                  {(row) => <ProjectRow row={row} state={props.state} />}
                </For>
              </SidebarNavSection>
            </Show>
            <Show when={props.state.tree().skipped > 0}>
              <EmptyDescription>
                {props.state.tree().skipped === 1
                  ? '1 project has no GitHub or GitLab repository.'
                  : `${props.state.tree().skipped} projects have no GitHub or GitLab repository.`}
              </EmptyDescription>
            </Show>
          </nav>
        </SidebarNavContent>
        <SidebarNavFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="w-full justify-start"
            onClick={() => props.onConnect()}
          >
            <Plus aria-hidden="true" />
            Connect account
          </Button>
        </SidebarNavFooter>
      </SidebarNav>
    </div>
  )
}
