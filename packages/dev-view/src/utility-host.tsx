import type { CapabilitySnapshot, DevCapability, DevUtilityPane } from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  SideRail,
  SideRailContent,
  SideRailItem,
  SideRailSection,
} from '@adea-ai/ui/components/layout/side-rail'
import { Maximize2, X } from 'lucide-solid'
import { For, Show, Suspense, createResource, lazy, onCleanup } from 'solid-js'

import {
  createDevUtilityFenceSource,
  isDevUtilityContextChanged,
  sameDevUtilityScope,
} from './utility-context'
import type { DevUtilityContextReader } from './utility-context'
import { hasDevUtilitySession } from './utility-context'
import type { CanonicalRuntimeBinding } from './utility-context'
import type { SharedDevUtilityOwner } from './utility-owner'
import { defaultRightUtilitySize, utilityItems } from './utility-model'
import { UtilityResizeHandle } from './utility-resize-handle'

const BrowserPane = lazy(() =>
  import('./browser/browser-pane').then((module) => ({ default: module.BrowserPane }))
)
const DevicesPane = lazy(() =>
  import('./devices/devices-pane').then((module) => ({ default: module.DevicesPane }))
)
const ActivityPane = lazy(() =>
  import('./resources/activity-pane').then((module) => ({ default: module.ActivityPane }))
)
const HarnessStatusSection = lazy(() =>
  import('./agents/harness-status-section').then((module) => ({
    default: module.HarnessStatusSection,
  }))
)
const RunHistorySection = lazy(() =>
  import('./history/run-history-section').then((module) => ({ default: module.RunHistorySection }))
)

const paneCapabilities: Partial<Record<DevUtilityPane, DevCapability>> = {
  browser: 'dev.browser.read',
  devices: 'dev.device.read',
  agents: 'dev.session.read',
  history: 'dev.session.read',
}

function scopeKey(context: ReturnType<DevUtilityContextReader>): string | undefined {
  const scope = context.scope
  if (!scope || context.runtime.state().status !== 'ready') return undefined
  return JSON.stringify([context.revision, scope.accountId, scope.workspaceId, scope.runtimeNodeId])
}

/**
 * Lazy cross-view host for the existing Dev utility panes. The Dev center,
 * projection, terminal, and editor are not part of this render boundary.
 */
export function SharedDevUtilityHost(props: {
  owner: SharedDevUtilityOwner
  restoreFocusRef?: () => HTMLElement | undefined
}) {
  const context: DevUtilityContextReader = props.owner.context
  const fences = createDevUtilityFenceSource(context)
  onCleanup(() => fences.dispose())
  const [capabilities] = createResource(
    () => scopeKey(context()),
    async (key): Promise<{ key: string; snapshot?: CapabilitySnapshot }> => {
      const fence = fences.capture('scope')
      if (!key || !fence || scopeKey(fence.context) !== key) return { key: key ?? '' }
      try {
        const snapshot = await fence.context.runtime.capabilitySnapshot(fence.context.scope!)
        if (!fence.isCurrent() || !sameDevUtilityScope(snapshot.scope, fence.context.scope))
          return { key }
        return { key, snapshot }
      } catch (error) {
        if (isDevUtilityContextChanged(error)) return { key }
        return { key }
      }
    }
  )
  const currentKey = () => scopeKey(context())
  const expectedBinding = (): CanonicalRuntimeBinding | null => {
    const current = context()
    if (
      !hasDevUtilitySession(current) ||
      !current.scope ||
      !current.projectId ||
      !current.runtimeSessionId
    )
      return null
    return {
      scope: current.scope,
      projectId: current.projectId,
      runtimeSessionId: current.runtimeSessionId,
      sessionGeneration: current.sessionGeneration!,
      worktreeId: current.worktreeId,
    }
  }
  const capabilityOf = (pane: DevUtilityPane) => {
    const capability = paneCapabilities[pane]
    const result = capabilities()
    if (!capability || !result || result.key !== currentKey()) return undefined
    const snapshot = result.snapshot
    const granted = snapshot?.granted.includes(capability)
    const unavailable = snapshot?.unavailable.find((item) => item.capability === capability)
    return granted === undefined
      ? undefined
      : { granted, ...(unavailable?.reason ? { reason: unavailable.reason } : {}) }
  }
  const paneItems = () =>
    utilityItems
      .filter((item) => item.side === 'right')
      .toSorted((a, b) => {
        const preferences = props.owner.utilityPreferences()
        return (
          (preferences.find((entry) => entry.pane === a.pane)?.order ?? 0) -
          (preferences.find((entry) => entry.pane === b.pane)?.order ?? 0)
        )
      })
  const visiblePane = () =>
    props.owner.utilityPreferences().find((item) => item.side === 'right' && item.visible)
  const selected = () => visiblePane()?.pane ?? 'browser'
  const title = () => paneItems().find((item) => item.pane === selected())?.title ?? 'Utilities'
  const runtimeReady = () => context().runtime.state().status === 'ready'

  const paneBody = (pane: DevUtilityPane) => {
    if (pane === 'browser')
      return runtimeReady() ? (
        <BrowserPane context={context} />
      ) : (
        <ProviderState
          title="Browser"
          capability={paneCapabilities.browser}
          state={capabilityOf('browser')}
          runtimeUnavailable
        />
      )
    if (pane === 'devices')
      return runtimeReady() ? (
        <DevicesPane context={context} />
      ) : (
        <ProviderState
          title="Devices"
          capability={paneCapabilities.devices}
          state={capabilityOf('devices')}
          runtimeUnavailable
        />
      )
    if (pane === 'agents')
      return runtimeReady() ? (
        <Suspense
          fallback={
            <ProviderState
              title="Agents"
              capability={paneCapabilities.agents}
              state={capabilityOf('agents')}
            />
          }
        >
          <HarnessStatusSection context={context} />
          <ActivityPane context={context} />
        </Suspense>
      ) : (
        <ProviderState
          title="Agents"
          capability={paneCapabilities.agents}
          state={capabilityOf('agents')}
          runtimeUnavailable
        />
      )
    return runtimeReady() ? (
      <Suspense
        fallback={
          <ProviderState
            title="History"
            capability={paneCapabilities.history}
            state={capabilityOf('history')}
          />
        }
      >
        <RunHistorySection context={context} />
      </Suspense>
    ) : (
      <ProviderState
        title="History"
        capability={paneCapabilities.history}
        state={capabilityOf('history')}
        runtimeUnavailable
      />
    )
  }

  return (
    <aside
      class={cn('dev-utility dev-utility--right dev-utility--open', {
        'dev-utility--size-240': visiblePane()?.size === 240,
        'dev-utility--size-336': visiblePane()?.size === 336,
        'dev-utility--size-384': visiblePane()?.size === 384,
        'dev-utility--size-448': visiblePane()?.size === 448,
        'dev-utility--size-512': visiblePane()?.size === 512,
        'dev-utility--size-600': visiblePane()?.size === 600,
        'dev-utility--cross-view-full': visiblePane()?.fullWidth,
      })}
      id="dev-utility-right"
      aria-label="Shared developer utilities"
    >
      <SideRail collapsed aria-label="Right utility panes">
        <SideRailContent>
          <SideRailSection label="Utilities">
            <For each={paneItems()}>
              {(item) => {
                const Icon = item.icon
                return (
                  <SideRailItem
                    as="button"
                    type="button"
                    label={item.title}
                    aria-label={item.title}
                    aria-controls="dev-utility-panel-right"
                    active={selected() === item.pane}
                    onClick={() => props.owner.showUtilityPane(item.pane, expectedBinding())}
                  >
                    <Icon aria-hidden="true" />
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
          <h2 id="dev-utility-heading-right">{title()}</h2>
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-sm"
            tooltip={visiblePane()?.fullWidth ? 'Restore utility pane' : 'Expand utility pane'}
            aria-label={visiblePane()?.fullWidth ? 'Restore utility pane' : 'Expand utility pane'}
            aria-expanded={visiblePane()?.fullWidth ?? false}
            onClick={() =>
              props.owner.setUtilityPaneFullWidth(
                selected(),
                !visiblePane()?.fullWidth,
                expectedBinding()
              )
            }
          >
            <Maximize2 aria-hidden="true" />
          </ActionButton>
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-sm"
            tooltip="Collapse utility sidebar"
            aria-label="Collapse utility sidebar"
            onClick={() => {
              props.owner.collapseRightUtility(expectedBinding())
              requestAnimationFrame(() => props.restoreFocusRef?.()?.focus())
            }}
          >
            <X aria-hidden="true" />
          </ActionButton>
        </div>
        <div class="dev-utility-panel__content">
          <Show
            when={['unavailable', 'corrupt', 'unsupported'].includes(
              props.owner.layoutLoadState() ?? ''
            )}
          >
            <Alert>
              <AlertDescription>
                <Show
                  when={props.owner.layoutLoadState() === 'unavailable'}
                  fallback="Stored layout settings could not be read. The original is kept for recovery."
                >
                  Saved layout settings could not load. Your current changes are kept for retry.
                </Show>
              </AlertDescription>
              <Show when={props.owner.layoutLoadState() === 'unavailable'}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => props.owner.retryLayoutStorage()}
                >
                  Retry layout settings
                </Button>
              </Show>
            </Alert>
          </Show>
          <Suspense fallback={<p class="dev-pane-state__line">Loading pane…</p>}>
            {paneBody(selected())}
          </Suspense>
        </div>
      </section>
      <Show when={visiblePane() && !visiblePane()?.fullWidth}>
        <UtilityResizeHandle
          side="right"
          size={visiblePane()?.size ?? defaultRightUtilitySize}
          onResize={(size) => props.owner.setUtilityPaneSize(selected(), size, expectedBinding())}
        />
      </Show>
    </aside>
  )
}

function ProviderState(props: {
  title: string
  capability?: DevCapability
  state?: { granted: boolean; reason?: string }
  runtimeUnavailable?: boolean
}) {
  return (
    <p class="dev-pane-state__line" role="status">
      <Show
        when={!props.runtimeUnavailable}
        fallback={`${props.title} is unavailable because the runtime is not connected.`}
      >
        <Show
          when={props.state}
          fallback={`${props.title} requires ${props.capability ?? 'a runtime capability'}, which is unavailable until the runtime reports its status.`}
        >
          <Show
            when={props.state!.granted}
            fallback={`${props.title} requires ${props.capability ?? 'a runtime capability'}, which is unavailable${
              props.state!.reason ? ` (${props.state!.reason})` : ''
            }.`}
          >
            {`${props.title} is connected through ${props.capability ?? 'a runtime capability'}. Its interactive surface is delivered by the owning provider slice.`}
          </Show>
        </Show>
      </Show>
    </p>
  )
}
