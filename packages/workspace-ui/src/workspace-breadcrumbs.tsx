import { WorkspaceIdentityMark } from '@adea-ai/app-ui/components/workspace-identity-mark'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@adea-ai/ui/components/ui/breadcrumb'
import { Text } from '@adea-ai/ui/components/ui/typography'
import { createViewAdapter } from '@adea-ai/workspace-nav/adapters'
import { breadcrumbsFor, type NavCrumb } from '@adea-ai/workspace-nav/breadcrumbs'
import type { NavTree } from '@adea-ai/workspace-nav/model'
import type { WorkspaceSummary } from '@adea-ai/types'
import { For, Show } from 'solid-js'

/**
 * A crumb as the top bar renders it: the pure crumb plus how its target opens.
 * A crumb without `onSelect` is plain text — never a link that does nothing.
 */
export type WorkspaceBreadcrumb = NavCrumb &
  Readonly<{
    /** Where the crumb's target lives, so the link also opens in a new tab. */
    href?: string
    onSelect?: () => void
  }>

/** What Dev View reports about its selection; branch names stay on the client. */
export type DevBreadcrumbSelection = Readonly<{
  projectId: string
  projectName: string
  /** The project's checked-out branch, when known. */
  branch?: string
}>

/**
 * Dev's crumbs: Workspace › Project › branch (mono). Dev is not on the shared
 * sidebar tree yet, so the host projects its selection into a one-leaf tree
 * and reads it through the same `breadcrumbsFor` and Dev adapter.
 */
export function devBreadcrumbs(
  workspace: Pick<WorkspaceSummary, 'id' | 'name' | 'logo' | 'accent'>,
  selection: DevBreadcrumbSelection | undefined
): NavCrumb[] {
  const leafId = selection?.branch ? `${selection.projectId}:checkout` : undefined
  const tree: NavTree = {
    activeWorkspaceId: workspace.id,
    needsYou: 0,
    workspaces: [
      {
        id: workspace.id,
        name: workspace.name,
        logo: workspace.logo,
        accent: workspace.accent,
        sortOrder: 0,
        summary: { running: 0, needsYou: 0, unread: 0 },
        projects: selection
          ? [
              {
                id: selection.projectId,
                name: selection.projectName,
                source: 'local_repo',
                sortOrder: 0,
                leaves: leafId
                  ? [
                      {
                        id: leafId,
                        kind: 'checkout',
                        projectId: selection.projectId,
                        branchRef: selection.branch,
                        status: 'idle',
                        lastActivityAt: '',
                      },
                    ]
                  : [],
              },
            ]
          : [],
      },
    ],
  }
  return breadcrumbsFor(tree, { leafId, projectId: selection?.projectId }, createViewAdapter('dev'))
}

function openCrumb(event: MouseEvent, crumb: WorkspaceBreadcrumb) {
  // Modified and middle clicks keep the browser's own link behaviour.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  crumb.onSelect?.()
}

function CrumbLabel(props: { crumb: WorkspaceBreadcrumb }) {
  return (
    <>
      <span class="visually-hidden">{`${props.crumb.noun}: `}</span>
      <Show when={props.crumb.label.mono} fallback={props.crumb.label.text}>
        <Text variant="code">{props.crumb.label.text}</Text>
      </Show>
    </>
  )
}

/**
 * The Workspace › Project › Leaf path in the top bar's title slot (ADR 0011).
 * The last crumb is the current page; earlier crumbs open their default leaf
 * when they have one, and are plain text otherwise.
 */
export function WorkspaceBreadcrumbs(props: { crumbs: readonly WorkspaceBreadcrumb[] }) {
  return (
    <Breadcrumb class="min-w-0">
      <BreadcrumbList class="min-w-0 flex-nowrap justify-center overflow-hidden">
        <For each={props.crumbs}>
          {(crumb, index) => (
            <>
              <Show when={index() > 0}>
                <BreadcrumbSeparator class="inline-flex shrink-0" />
              </Show>
              <BreadcrumbItem
                class="min-w-0 shrink-3 data-[crumb=leaf]:shrink"
                data-crumb={crumb.kind}
              >
                <Show when={crumb.workspace}>
                  {(identity) => (
                    <span class="workspace-topbar__crumb-mark" aria-hidden="true">
                      <WorkspaceIdentityMark
                        name={crumb.label.text}
                        logo={identity().logo}
                        accent={identity().accent}
                        size="xs"
                      />
                    </span>
                  )}
                </Show>
                <Show
                  when={crumb.current || !crumb.onSelect}
                  fallback={
                    <BreadcrumbLink
                      class="min-w-0 overflow-hidden"
                      href={crumb.href}
                      onClick={(event) => openCrumb(event, crumb)}
                    >
                      <span class="workspace-topbar__crumb-label">
                        <CrumbLabel crumb={crumb} />
                      </span>
                    </BreadcrumbLink>
                  }
                >
                  <Show
                    when={crumb.current}
                    fallback={
                      <span class="workspace-topbar__crumb-label">
                        <CrumbLabel crumb={crumb} />
                      </span>
                    }
                  >
                    <BreadcrumbLink current class="min-w-0 overflow-hidden">
                      <span class="workspace-topbar__crumb-label">
                        <CrumbLabel crumb={crumb} />
                      </span>
                    </BreadcrumbLink>
                  </Show>
                </Show>
              </BreadcrumbItem>
            </>
          )}
        </For>
      </BreadcrumbList>
    </Breadcrumb>
  )
}
