import '../../src/start/globals.css'
import { render } from 'solid-js/web'
import { For, createMemo, createSignal } from 'solid-js'
import { TooltipProvider } from '@adea-ai/ui/components/ui/tooltip'
import { WorkspaceNav } from '../../../../packages/workspace-nav/src/workspace-nav'
import type { NavGroupMode, NavTree } from '../../../../packages/workspace-nav/src/model'
import { workspaceNavFixtures } from './workspace-nav-fixtures'

/**
 * Renders the shared sidebar with fixture data. Every callback appends a line
 * to the "Nav events" log so the spec can assert what the host would receive.
 * The sidebar holds the selected workspace alone: the top bar's switcher (not
 * this component) changes it, so the harness exposes `?workspace=` to pick one.
 */
const requested = new URLSearchParams(window.location.search).get('workspace')
const [groupBy, setGroupBy] = createSignal<NavGroupMode>('project')
const [selectedLeafId, setSelectedLeafId] = createSignal<string | null>(null)
const [events, setEvents] = createSignal<string[]>([])
const log = (line: string) => setEvents((current) => [...current, line])

const tree = createMemo<NavTree>(() => {
  const workspace =
    workspaceNavFixtures.find(({ id }) => id === requested) ?? workspaceNavFixtures[0]!
  return { activeWorkspaceId: workspace.id, workspaces: [workspace] }
})

// Expansion is controlled by the host in the app (the store); the harness does
// the same so the spec proves one project never collapses another.
const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())

render(
  () => (
    <TooltipProvider openDelay={200} closeDelay={300} skipDelayDuration={300}>
      <div class="flex w-64 flex-col p-2">
        <WorkspaceNav
          tree={tree()}
          view="dev"
          groupBy={groupBy()}
          onGroupByChange={(mode) => {
            log(`group:${mode}`)
            setGroupBy(mode)
          }}
          selectedLeafId={selectedLeafId()}
          onSelectLeaf={(leaf) => {
            log(`leaf:${leaf.id}`)
            setSelectedLeafId(leaf.id)
          }}
          onCreateProject={() => log('add-project')}
          onOpenProjectSettings={(project) => log(`project-settings:${project.id}`)}
          onCreateLeaf={(project) => log(`create-leaf:${project.id}`)}
          onProjectMenuAction={(id, project) => log(`project-menu:${id}:${project.id}`)}
          onLeafMenuAction={(id, leaf) => log(`leaf-menu:${id}:${leaf.id}`)}
          collapsedProjectIds={collapsed()}
          onProjectExpandedChange={(projectId, expanded) => {
            log(`${expanded ? 'expand' : 'collapse'}:${projectId}`)
            setCollapsed((current) => {
              const next = new Set(current)
              if (expanded) next.delete(projectId)
              else next.add(projectId)
              return next
            })
          }}
        />
      </div>
      <ol aria-label="Nav events">
        <For each={events()}>{(line) => <li>{line}</li>}</For>
      </ol>
    </TooltipProvider>
  ),
  document.querySelector('#harness-root')!
)
