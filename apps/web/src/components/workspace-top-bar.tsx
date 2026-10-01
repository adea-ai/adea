import { useRouter } from '@tanstack/solid-router'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { TopBar, TopBarSection, TopBarTitle } from '@adea-ai/ui/components/layout/top-bar'
import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-solid'
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import { workspaceHistoryPosition } from '../lib/workspace-history'
import { WorkspaceAppearanceControl } from './workspace-appearance-control'

const HISTORY_KEY = 'adea:workspace-history-maximum:v1'

/** Host navigation and native chrome around the published shared TopBar. */
export function WorkspaceTopBar(props: {
  platform: 'desktop' | 'web'
  title: string
  onSearch(): void
  actionsMount(element: HTMLDivElement): void
}) {
  const router = useRouter()
  const sidebarOpen = useWorkspaceState((state) => state.mobileSidebarOpen)
  const [macos, setMacos] = createSignal(false)
  const [position, setPosition] = createSignal(workspaceHistoryPosition(undefined, 'REPLACE', 0))

  onMount(() => {
    setMacos(props.platform === 'desktop' && /Mac/.test(navigator.platform))
    let restored: number | undefined
    try {
      // Reload keeps this tab's branch. Fresh or external/BFCache arrivals
      // cannot prove it still exists, so they deliberately collapse it.
      const arrival = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined
      const raw = window.sessionStorage.getItem(HISTORY_KEY)
      const value = raw === null ? NaN : Number(raw)
      if (arrival?.type === 'reload' && Number.isSafeInteger(value) && value >= 0) restored = value
    } catch {
      // Storage and timing are optional; navigation itself remains available.
    }
    const record = (action: string, index: unknown, maximum = position().maximum) => {
      const next = workspaceHistoryPosition(maximum, action, index)
      setPosition(next)
      try {
        if (next.maximum === undefined) window.sessionStorage.removeItem(HISTORY_KEY)
        else window.sessionStorage.setItem(HISTORY_KEY, String(next.maximum))
      } catch {
        // Keep the in-memory frontier when storage is denied.
      }
    }
    record('REPLACE', router.history.location.state.__TSR_index, restored)
    const unsubscribe = router.history.subscribe(({ action, location }) => {
      record(action.type, location.state.__TSR_index)
    })
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        const next = workspaceHistoryPosition(
          undefined,
          'REPLACE',
          router.history.location.state.__TSR_index
        )
        record('REPLACE', router.history.location.state.__TSR_index, next.maximum)
      }
    }
    window.addEventListener('pageshow', onPageShow)
    onCleanup(() => {
      unsubscribe()
      window.removeEventListener('pageshow', onPageShow)
    })
  })

  return (
    <TopBar
      class="workspace-topbar"
      draggable={props.platform === 'desktop'}
      macosInset={macos()}
      aria-label="Workspace toolbar"
    >
      <TopBarSection class="workspace-topbar__navigation">
        <ActionButton
          variant="ghost"
          size="icon-sm"
          tooltip="Back"
          class="workspace-topbar__control"
          aria-label="Back"
          disabled={!position().canGoBack}
          onClick={() => router.history.back()}
        >
          <ArrowLeft aria-hidden="true" />
        </ActionButton>
        <ActionButton
          variant="ghost"
          size="icon-sm"
          tooltip="Forward"
          class="workspace-topbar__control"
          aria-label="Forward"
          disabled={!position().canGoForward}
          onClick={() => router.history.forward()}
        >
          <ArrowRight aria-hidden="true" />
        </ActionButton>
        <ActionButton
          variant="ghost"
          size="icon-sm"
          tooltip={sidebarOpen() ? 'Collapse contextual sidebar' : 'Expand contextual sidebar'}
          class="workspace-topbar__control"
          aria-label={sidebarOpen() ? 'Collapse contextual sidebar' : 'Expand contextual sidebar'}
          aria-expanded={sidebarOpen()}
          onClick={() => workspaceStore.getState().setMobileSidebarOpen(!sidebarOpen())}
        >
          <Show when={sidebarOpen()} fallback={<PanelLeftOpen aria-hidden="true" />}>
            <PanelLeftClose aria-hidden="true" />
          </Show>
        </ActionButton>
      </TopBarSection>
      <TopBarTitle class="workspace-topbar__title">{props.title}</TopBarTitle>
      <TopBarSection align="end" class="workspace-topbar__actions">
        <div class="workspace-topbar__view-actions" ref={props.actionsMount} />
        <WorkspaceAppearanceControl />
        <ActionButton
          variant="ghost"
          size="icon-sm"
          tooltip="Search workspace"
          class="workspace-topbar__control"
          aria-label="Search workspace"
          onClick={props.onSearch}
        >
          <Search aria-hidden="true" />
        </ActionButton>
      </TopBarSection>
    </TopBar>
  )
}
