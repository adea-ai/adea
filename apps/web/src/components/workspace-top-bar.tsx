import { useRouter } from '@tanstack/solid-router'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { TopBar, TopBarSection, TopBarTitle } from '@adea-ai/ui/components/layout/top-bar'
import { Separator } from '@adea-ai/ui/components/ui/separator'
import { ArrowLeft, ArrowRight, Bell, PanelLeftClose, PanelLeftOpen } from 'lucide-solid'
import type { JSX } from 'solid-js'
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import {
  WorkspaceBreadcrumbs,
  type WorkspaceBreadcrumb,
} from '@adea-ai/workspace-ui/workspace-breadcrumbs'
import { workspaceHistoryPosition } from '../lib/workspace-history'
import { WorkspaceAppearanceControl } from './workspace-appearance-control'

const HISTORY_KEY = 'adea:workspace-history-maximum:v1'

/** Host navigation and native chrome around the published shared TopBar. */
export function WorkspaceTopBar(props: {
  platform: 'desktop' | 'web'
  /** The plain title, shown while the active surface supplies no breadcrumbs. */
  title: string
  /**
   * Workspace › Project › Leaf in the title slot. It replaces the plain title
   * in place: same slot, same truncation, no extra row.
   */
  breadcrumbs?: readonly WorkspaceBreadcrumb[]
  onOpenNotifications(): void
  actionsMount(element: HTMLDivElement): void
  /** Mount Dev pane controls only while Dev owns the active surface. */
  showDevActions: boolean
  sidebarToggleRef?: (element: HTMLButtonElement | undefined) => void
  /** Edit views run without a contextual sidebar, so the toggle has nothing to control. */
  hideSidebarToggle?: boolean
  /** Workspace-wide actions rendered before the appearance control. */
  resources?: JSX.Element
  /**
   * Mount for the active view's title-slot control: the source-control view
   * portals its pull-request search here so it sits where the plain title
   * (the workspace name) would, centered in the bar. Rendered only while
   * `showTitleControls` is set, which also suppresses the plain title and
   * breadcrumbs for that view.
   */
  titleMount?(element: HTMLDivElement): void
  /** Whether the active view owns the title slot with its own control. */
  showTitleControls?: boolean
  /**
   * Mount for the active view's sidebar toggle: the top bar's trailing icon,
   * separated from the workspace actions by a divider.
   */
  sidebarMount(element: HTMLDivElement): void
  /**
   * Whether the active view mounts a right-sidebar control into the trailing
   * slot. Views without one leave the slot empty, and an empty slot renders
   * no divider either — a divider ahead of nothing just reads as noise.
   */
  showSidebarDivider: boolean
}) {
  const router = useRouter()
  const sidebarOpen = useWorkspaceState((state) => state.mobileSidebarOpen)
  // The workspace mount is browser-only, so navigator is readable at first
  // render. Deriving the inset eagerly (not in onMount) reserves the traffic
  // light column on the first paint; deriving it late let the back/forward
  // controls render under the macOS window buttons for a frame or forever,
  // depending on hydration.
  const [macos] = createSignal(
    props.platform === 'desktop' &&
      typeof navigator !== 'undefined' &&
      /Mac/.test(navigator.platform)
  )
  const [position, setPosition] = createSignal(workspaceHistoryPosition(undefined, 'REPLACE', 0))

  onMount(() => {
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
    // Captures the component's history position signal (also read in the
    // default parameter, which the scoping rule does not count).
    // oxlint-disable-next-line unicorn/consistent-function-scoping
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
      data-workspace-topbar=""
      data-dev-actions={props.showDevActions ? '' : undefined}
      draggable={props.platform === 'desktop'}
      macosInset={macos()}
      aria-label="Workspace toolbar"
    >
      <TopBarSection
        data-topbar-navigation=""
        data-dev-actions={props.showDevActions ? '' : undefined}
      >
        <div class="workspace-topbar__navigation-controls">
          <ActionButton
            variant="ghost"
            size="icon-sm"
            tooltip="Back"
            tooltipIcon={<ArrowLeft aria-hidden="true" />}
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
            tooltipIcon={<ArrowRight aria-hidden="true" />}
            aria-label="Forward"
            disabled={!position().canGoForward}
            onClick={() => router.history.forward()}
          >
            <ArrowRight aria-hidden="true" />
          </ActionButton>
          <Show when={!props.hideSidebarToggle}>
            <ActionButton
              ref={props.sidebarToggleRef}
              variant="outline"
              size="icon-sm"
              tooltip={sidebarOpen() ? 'Collapse contextual sidebar' : 'Expand contextual sidebar'}
              tooltipIcon={
                <Show when={sidebarOpen()} fallback={<PanelLeftOpen aria-hidden="true" />}>
                  <PanelLeftClose aria-hidden="true" />
                </Show>
              }
              class="min-h-6 min-w-6"
              data-context-toggle=""
              aria-label={
                sidebarOpen() ? 'Collapse contextual sidebar' : 'Expand contextual sidebar'
              }
              aria-expanded={sidebarOpen()}
              onClick={() => workspaceStore.getState().setMobileSidebarOpen(!sidebarOpen())}
            >
              <Show when={sidebarOpen()} fallback={<PanelLeftOpen aria-hidden="true" />}>
                <PanelLeftClose aria-hidden="true" />
              </Show>
            </ActionButton>
          </Show>
        </div>
        <div class="workspace-topbar__view-action-group">
          {/* The divider renders on every view so the left side of the bar has
              one shape: back/forward/contextual toggle, divider, then the
              Dev-only pane section (empty everywhere else). */}
          <Separator orientation="vertical" data-topbar-view-divider="" aria-hidden="true" />
          <div
            class="workspace-topbar__view-actions"
            ref={props.actionsMount}
            role={props.showDevActions ? 'toolbar' : undefined}
            aria-label={props.showDevActions ? 'Developer workspace actions' : undefined}
          />
        </div>
      </TopBarSection>
      <TopBarTitle data-topbar-title="">
        <Show
          when={props.showTitleControls}
          fallback={
            <Show when={props.breadcrumbs?.length} fallback={props.title}>
              <WorkspaceBreadcrumbs crumbs={props.breadcrumbs ?? []} />
            </Show>
          }
        >
          <div class="workspace-topbar__title-mount" ref={props.titleMount} />
        </Show>
      </TopBarTitle>
      <TopBarSection align="end" data-topbar-actions="">
        {props.resources}
        <WorkspaceAppearanceControl />
        <ActionButton
          variant="ghost"
          size="icon-sm"
          tooltip="Notifications are not available yet."
          tooltipIcon={<Bell aria-hidden="true" />}
          aria-label="Notifications"
          aria-description="Notifications are not available yet."
          disabled
        >
          <Bell aria-hidden="true" />
        </ActionButton>
        {/* The trailing slot mirrors the leading one: divider first, then the
            active view's right-sidebar toggle (Dev portals its utility-pane
            control). Views without a right pane render no slot at all — the
            empty wrapper would still take its share of the section's gap and
            read as extra right padding after the notifications bell — and own
            the contextual sidebar through the leading toggle, so exactly one
            control speaks for each side on every view. */}
        <Show when={props.showSidebarDivider}>
          <div class="workspace-topbar__sidebar">
            <Separator orientation="vertical" data-topbar-sidebar-divider="" />
            <div class="workspace-topbar__sidebar-mount" ref={props.sidebarMount} />
          </div>
        </Show>
      </TopBarSection>
    </TopBar>
  )
}
