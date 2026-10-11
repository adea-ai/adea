import type { DevCapability, DevUtilityPane } from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@adea-ai/ui/components/ui/resizable'
import {
  SideRail,
  SideRailContent,
  SideRailItem,
  SideRailSection,
} from '@adea-ai/ui/components/layout/side-rail'
import { History, Laptop, Maximize2, MonitorSmartphone, Users, X } from 'lucide-solid'
import { For, Show, Suspense, lazy } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import { paneCapability, utilityItemByPane } from './definitions'
import type { DevUtilityOwnerModel } from './owner'

const BrowserPane = lazy(() =>
  import('../browser/browser-pane').then((module) => ({ default: module.BrowserPane }))
)
const DevicesPane = lazy(() =>
  import('../devices/devices-pane').then((module) => ({ default: module.DevicesPane }))
)
const ActivityPane = lazy(() =>
  import('../resources/activity-pane').then((module) => ({ default: module.ActivityPane }))
)
const HarnessStatusSection = lazy(() =>
  import('../agents/harness-status-section').then((module) => ({
    default: module.HarnessStatusSection,
  }))
)
const RunHistorySection = lazy(() =>
  import('../history/run-history-section').then((module) => ({
    default: module.RunHistorySection,
  }))
)

const utilitySizeSteps = [240, 288, 336, 384] as const
const maxUtilitySize = utilitySizeSteps[utilitySizeSteps.length - 1]

export function DevRightUtilitySidebar(props: {
  owner: DevUtilityOwnerModel
  runtime: DevRuntimeService
}) {
  const visiblePane = () => props.owner.visiblePaneOf('right')
  const visibleItem = () => {
    const pane = visiblePane()?.pane
    return pane ? utilityItemByPane.get(pane) : undefined
  }
  const panes = () => props.owner.panesOfSide('right')
  const runtimeReady = () => props.runtime.state().status === 'ready'
  const hasScope = () => Boolean(props.owner.activeScope())
  const hasSession = () => Boolean(props.owner.selectedSession())

  const providerState = (pane: DevUtilityPane) => (
    <PaneProviderState
      title={utilityItemByPane.get(pane)!.title}
      capability={paneCapability[pane]}
      state={props.owner.capabilityOf(pane)}
      runtimeState={props.runtime.state()}
      hasScope={hasScope()}
      hasSession={hasSession()}
    />
  )

  const body = (pane: DevUtilityPane) => {
    if (!runtimeReady()) return providerState(pane)
    if (!hasScope() || !hasSession()) return providerState(pane)
    if (pane === 'browser')
      return <BrowserPane runtime={props.runtime} runtimeSessionId={props.owner.selectedSession()} />
    if (pane === 'devices')
      return <DevicesPane runtime={props.runtime} runtimeSessionId={props.owner.selectedSession()} />
    if (pane === 'agents')
      return (
        <Suspense fallback={providerState(pane)}>
          <HarnessStatusSection
            runtime={props.runtime}
            runtimeSessionId={props.owner.selectedSession()}
          />
          <ActivityPane runtime={props.runtime} runtimeSessionId={props.owner.selectedSession()} />
        </Suspense>
      )
    if (pane === 'history')
      return (
        <Suspense fallback={providerState(pane)}>
          <RunHistorySection
            runtime={props.runtime}
            runtimeSessionId={props.owner.selectedSession()}
          />
        </Suspense>
      )
    return providerState(pane)
  }

  return (
    <aside
      class={cn('dev-utility dev-utility--right dev-utility--open', {
        'dev-utility--size-240': visiblePane()?.size === 240,
        'dev-utility--size-336': visiblePane()?.size === 336,
        'dev-utility--size-384': visiblePane()?.size === 384,
        'dev-utility--right-full': visiblePane()?.fullWidth,
      })}
      id="dev-utility-right"
      aria-label="Developer utilities (right)"
    >
      <SideRail collapsed aria-label="Right utility panes">
        <SideRailContent>
          <SideRailSection label="Utilities">
            <For each={panes()}>
              {(item) => {
                const meta = utilityItemByPane.get(item.pane)!
                const selected = () => visiblePane()?.pane === item.pane
                return (
                  <SideRailItem
                    as="button"
                    type="button"
                    label={meta.title}
                    aria-label={meta.title}
                    aria-controls="dev-utility-panel-right"
                    active={selected()}
                    onClick={() => props.owner.showPane(item.pane)}
                  >
                    <RightPaneIcon pane={item.pane} />
                  </SideRailItem>
                )
              }}
            </For>
          </SideRailSection>
        </SideRailContent>
      </SideRail>
      <section
        id="dev-utility-panel-right"
        aria-labelledby="dev-utility-heading-right"
        class="dev-utility-panel"
      >
        <div class="dev-utility-panel__heading">
          <h2 id="dev-utility-heading-right">{visibleItem()?.title}</h2>
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-sm"
            tooltip={visiblePane()?.fullWidth ? 'Restore utility pane' : 'Expand utility pane'}
            aria-label={visiblePane()?.fullWidth ? 'Restore utility pane' : 'Expand utility pane'}
            aria-pressed={visiblePane()?.fullWidth ?? false}
            onClick={() =>
              props.owner.setPaneFullWidth(visiblePane()!.pane, !visiblePane()!.fullWidth)
            }
          >
            <Maximize2 aria-hidden="true" />
          </ActionButton>
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-sm"
            tooltip="Collapse right utility slot"
            aria-label="Collapse right utility slot"
            onClick={() => props.owner.collapseSide('right')}
          >
            <X aria-hidden="true" />
          </ActionButton>
        </div>
        <div class="dev-utility-panel__content">
          <Suspense fallback={<p class="dev-pane-state__line">Loading pane…</p>}>
            {body(visiblePane()!.pane)}
          </Suspense>
        </div>
      </section>
      <Show when={!visiblePane()?.fullWidth}>
        <UtilityResizeHandle
          size={visiblePane()?.size ?? 288}
          onResize={(size) => props.owner.setPaneSize(visiblePane()!.pane, size)}
        />
      </Show>
    </aside>
  )
}

function RightPaneIcon(props: { pane: DevUtilityPane }) {
  if (props.pane === 'devices') return <MonitorSmartphone aria-hidden="true" />
  if (props.pane === 'agents') return <Users aria-hidden="true" />
  if (props.pane === 'history') return <History aria-hidden="true" />
  return <Laptop aria-hidden="true" />
}

function PaneProviderState(props: {
  title: string
  capability: DevCapability
  state?: { granted: boolean; reason?: string }
  runtimeState: ReturnType<DevRuntimeService['state']>
  hasScope: boolean
  hasSession: boolean
}) {
  const message = () => {
    if (props.runtimeState.status === 'unavailable')
      return `${props.title} is unavailable because the Dev Runtime channel is ${props.runtimeState.reason}.`
    if (!props.hasScope)
      return `${props.title} requires an authenticated runtime scope; this provider has not supplied one.`
    if (!props.hasSession)
      return `${props.title} requires a selected live RuntimeSession; none is available in this workspace.`
    if (!props.state)
      return `Requires ${props.capability}, which has not been reported by this provider yet.`
    if (!props.state.granted)
      return `${props.title} requires ${props.capability}, which is unavailable${
        props.state.reason ? ` (${props.state.reason})` : ''
      }.`
    return `${props.title} is connected through ${props.capability}. This pane's interactive surface is delivered by its owning provider slice.`
  }
  return (
    <div class="dev-pane-state" data-state="unavailable">
      <p class="dev-pane-state__line">{message()}</p>
    </div>
  )
}

function UtilityResizeHandle(props: { size: number; onResize(size: number): void }) {
  const sizeRatio = () => props.size / maxUtilitySize
  const rulerSizes = () => [1 - sizeRatio(), sizeRatio()]
  const resizedSize = (sizes: readonly number[]) =>
    Math.round((1 - (sizes[0] ?? 1)) * maxUtilitySize)

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      sizes={rulerSizes()}
      keyboardDelta="48px"
      class="dev-utility-splitter dev-utility-splitter--right"
      onSizesChange={(sizes) => {
        const nextSize = utilitySizeSteps.reduce(
          (best, step) =>
            Math.abs(step - resizedSize(sizes)) < Math.abs(best - resizedSize(sizes)) ? step : best,
          utilitySizeSteps[0]
        )
        if (nextSize !== props.size) props.onResize(nextSize)
      }}
    >
      <ResizablePanel minSize={0} maxSize={(maxUtilitySize - utilitySizeSteps[0]) / maxUtilitySize} aria-hidden="true" />
      <ResizableHandle
        withHandle
        label="Resize right utility pane"
        aria-controls="dev-utility-panel-right"
        aria-valuemin={utilitySizeSteps[0]}
        aria-valuemax={maxUtilitySize}
        aria-valuenow={props.size}
      />
      <ResizablePanel minSize={utilitySizeSteps[0] / maxUtilitySize} maxSize={1} aria-hidden="true" />
    </ResizablePanelGroup>
  )
}
