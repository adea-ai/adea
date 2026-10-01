/*
 * Browser pane: the right-side Browser/Devices utility's browser half.
 *
 * Composition (toolbar order, URL bar draft semantics, screenshot/mini-preview
 * toggles, responsive viewport and profile menu) is substantially translated
 * from t3code's PreviewChromeRow/PreviewMoreMenu/ThreadPreviewMiniPlayer
 * (MIT, revision 77bca8b2d76a1f42552e5eee7d277fcb1160347a) to Solid; the
 * lane identity strip implements the Dev Runtime spec's lane display rules.
 * Every host interaction rides DevRuntimeService commands — no desktop
 * imports, and unavailable capability renders as typed states. See NOTICE
 * and docs/research/dev-view-donor-audit.md.
 */
import type {
  BrowserInspection,
  BrowserLane,
  BrowserTarget,
  DevError,
  PortRecord,
  ProfilePolicy,
  Scope,
  ScreenshotRef,
} from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { Camera, Cookie, PictureInPicture2, RotateCw, X } from 'lucide-solid'
import { For, Show, createEffect, createResource, createSignal, onCleanup } from 'solid-js'

import './browser-pane.css'
import type { DevRuntimeService } from '../platform'
import { resolveAnnotationSubmission } from './annotation-model'
import { buildDevCommand } from './command'
import { CookieImportPanel } from './cookie-import-panel'
import {
  buildBrowserNavigationRequest,
  buildPortNavigationRequest,
  type BrowserNavigationRequest,
} from './navigation-model'
import { isPreviewableRow, mergeServers, type PreviewableServer } from './ports-model'
import { MiniPreview } from './mini-preview'
import {
  presetById,
  resolvePresetViewport,
  RESPONSIVE_PRESETS,
  type ResponsiveOrientation,
  type ResponsivePresetId,
} from './responsive-presets'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'

const LANE_KIND_LABEL: Record<BrowserLane['kind'], string> = {
  human_embedded: 'Human · embedded',
  task_owned: 'Task-owned agent',
  user_context: 'User context · external',
}

export type BrowserPaneProps = {
  runtime: DevRuntimeService
  runtimeSessionId?: string
}

type LanePage = { items: readonly BrowserLane[]; nextCursor?: string }
type TargetsPage = { items: readonly BrowserTarget[] }
type PortsPage = { items: readonly PortRecord[] }
type DiagnosticsPage = {
  items: readonly { id: string; level: string; category: string; message: string }[]
}
type ScreenshotContext = {
  runtime: DevRuntimeService
  runtimeStatus: string
  scopeKey?: string
  requestedSessionId?: string
  laneId?: string
  laneScopeKey?: string
  laneSessionId?: string
  laneGeneration?: number
  targetId?: string
  targetUrl?: string
  targetTitle?: string
  targetType?: BrowserTarget['type']
  viewportKey: string
  canCapture: boolean
}
type ScreenshotPaneResult = {
  reference: ScreenshotRef
  contextKey: string
  runtime: DevRuntimeService
}
type AppliedResponsiveViewport = Readonly<{
  laneId: string
  generation: number
  presetId: ResponsivePresetId
  orientation: ResponsiveOrientation
  zoomScale: number
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}>

function browserScopeKey(value: Scope | undefined): string | undefined {
  return value
    ? JSON.stringify([value.accountId, value.workspaceId, value.runtimeNodeId])
    : undefined
}

function screenshotContextKey(context: ScreenshotContext): string {
  return JSON.stringify([
    context.runtimeStatus,
    context.scopeKey,
    context.requestedSessionId,
    context.laneId,
    context.laneScopeKey,
    context.laneSessionId,
    context.laneGeneration,
    context.targetId,
    context.targetUrl,
    context.targetTitle,
    context.targetType,
    context.viewportKey,
  ])
}

function sameScreenshotContext(left: ScreenshotContext, right: ScreenshotContext): boolean {
  return (
    left.runtime === right.runtime && screenshotContextKey(left) === screenshotContextKey(right)
  )
}

function commandError(error: unknown): DevError {
  return (
    (error as { error?: DevError })?.error ?? {
      code: 'invalid_state',
      retryable: false,
      message: error instanceof Error ? error.message : 'command failed',
    }
  )
}

export function BrowserPane(props: BrowserPaneProps) {
  const runtime = () => props.runtime
  const scope = () => runtime().preferenceScope?.()
  const [activeLaneId, setActiveLaneId] = createSignal<string | undefined>(undefined)
  const [error, writeError] = createSignal<DevError | undefined>(undefined)
  let errorRevision = 0
  function setError(value: DevError | undefined): void {
    errorRevision += 1
    writeError(value)
  }
  const [urlDraft, setUrlDraft] = createSignal('')
  const [urlFocused, setUrlFocused] = createSignal(false)
  const [miniPreviewOpen, setMiniPreviewOpen] = createSignal(false)
  const [cookiesOpen, setCookiesOpen] = createSignal(false)
  const [appliedViewports, setAppliedViewports] = createSignal<
    ReadonlyMap<string, AppliedResponsiveViewport>
  >(new Map())
  const [inspectionSelector, setInspectionSelector] = createSignal('')
  const [inspectionResult, setInspectionResult] = createSignal<{
    laneId: string
    generation: number
    targetId: string
    value: BrowserInspection
  }>()
  const [inspectionBusy, setInspectionBusy] = createSignal(false)
  let latestInspectionRequest = 0
  const [screenshotResult, setScreenshotResult] = createSignal<ScreenshotPaneResult>()
  const [screenshotError, setScreenshotError] = createSignal<DevError>()
  const [screenshotBusy, setScreenshotBusy] = createSignal(false)
  let latestScreenshotRequest = 0
  const latestViewportRequests = new Map<string, number>()
  let screenshotMounted = true

  async function execute<T>(
    operation: Parameters<typeof buildDevCommand>[0]['operation'],
    body: Record<string, unknown>,
    resource?: { kind: string; id: string; generation: number }
  ): Promise<T> {
    const activeScope = scope()
    if (!activeScope) throw new Error('unauthenticated')
    const reply = await runtime().execute(
      buildDevCommand({ operation, scope: activeScope, body, ...(resource ? { resource } : {}) })
    )
    if (!reply.ok) throw reply
    return reply.value as T
  }

  const serviceReady = () => runtime().state().status === 'ready'
  const [lanes, { refetch: refetchLanes }] = createResource(serviceReady, async (ready) => {
    if (!ready) return { items: [] as BrowserLane[] }
    return execute<LanePage>(
      'dev.browser.lanes',
      props.runtimeSessionId ? { runtimeSessionId: props.runtimeSessionId } : {}
    )
  })

  const activeLane = () => {
    const items = lanes()?.items ?? []
    const current = items.find((lane) => lane.id === activeLaneId())
    return current ?? items[0]
  }

  const activePageTarget = () => {
    const lane = activeLane()
    if (!lane) return undefined
    return targets()?.items.find(
      (target) =>
        target.type === 'page' &&
        target.browserLaneId === lane.id &&
        target.generation === lane.generation
    )
  }

  const viewportForActiveLane = () => {
    const lane = activeLane()
    const viewport = lane ? appliedViewports().get(lane.id) : undefined
    return lane && viewport?.laneId === lane.id && viewport.generation === lane.generation
      ? viewport
      : undefined
  }

  function invalidateInspection(): void {
    latestInspectionRequest += 1
    setInspectionBusy(false)
    setInspectionResult(undefined)
  }

  const [targets, { refetch: refetchTargets }] = createResource(activeLane, async (lane) => {
    if (!lane) return { items: [] as BrowserTarget[] }
    // The contract for `dev.browser.targets` is
    // `{ browserLaneId; cursor?; limit? }` with the generation carried by the
    // RESOURCE binding. Sending `expectedGeneration` in the body made the
    // strict decoder reject it as an unknown key, so every Targets fetch was
    // refused and the browser pane's primary read never worked.
    return execute<TargetsPage>(
      'dev.browser.targets',
      { browserLaneId: lane.id },
      { kind: 'browser_lane', id: lane.id, generation: lane.generation }
    )
  })

  const [ports] = createResource(serviceReady, async (ready) => {
    if (!ready) return { items: [] as PortRecord[] }
    // The Ports menu consumes the read-only port projection; ownership
    // comes from the host's launch records, never from the scan itself.
    return execute<PortsPage>('dev.resources.ports', {})
  })

  const [diagnostics, { refetch: refetchDiagnostics }] = createResource(
    activeLane,
    async (lane) => {
      if (!lane) return { items: [] as DiagnosticsPage['items'] }
      return execute<DiagnosticsPage>(
        'dev.browser.diagnostics',
        { browserLaneId: lane.id, expectedGeneration: lane.generation },
        { kind: 'browser_lane', id: lane.id, generation: lane.generation }
      )
    }
  )

  const portRows = (): readonly PreviewableServer[] =>
    mergeServers({
      scanner: (ports()?.items ?? []).map((port) => ({
        host: port.host,
        port: port.port,
        url:
          port.preview?.url ??
          `http://${port.host === '127.0.0.1' ? 'localhost' : port.host}:${port.port}/`,
        processName: null,
        owner: port.owner,
        health: port.state === 'observed' ? 'listening' : 'stale',
        ...(port.runtimeSessionId ? { runtimeSessionId: port.runtimeSessionId } : {}),
        ...(port.preview ? { preview: port.preview } : {}),
      })),
      configuredUrls: [],
    })

  const portNavigationRequest = (row: PreviewableServer) =>
    buildPortNavigationRequest(row, lanes()?.items ?? [], activeLane())

  function currentUrl(): string {
    return activePageTarget()?.url ?? ''
  }

  function dispatchNavigation(request: BrowserNavigationRequest): void {
    invalidateInspection()
    clearScreenshotContext()
    execute<{
      browserLaneId: string
      targetId: string
      finalUrl: string
      status?: number
    }>(request.operation, request.body, request.resource)
      .then(() => {
        setError(undefined)
        void refetchTargets()
      })
      .catch((reply) => setError(commandError(reply)))
  }

  function navigateToUrl(value: string, lane = activeLane()): void {
    setUrlFocused(false)
    const request = buildBrowserNavigationRequest(value, lane)
    if (!request) return
    dispatchNavigation(request)
  }

  function submitUrl(): void {
    const value = urlFocused() ? urlDraft() : ''
    navigateToUrl(value)
  }

  function reloadCurrentPage(): void {
    const url = currentUrl()
    if (!url) return
    navigateToUrl(url)
  }

  function inspectSelector(event: SubmitEvent): void {
    event.preventDefault()
    const lane = activeLane()
    const target = activePageTarget()
    const selector = inspectionSelector().trim()
    if (!lane || !target || targets.loading || selector.length === 0 || selector.length > 512)
      return

    const requestId = ++latestInspectionRequest
    setInspectionBusy(true)
    setInspectionResult(undefined)
    setError(undefined)
    execute<BrowserInspection>(
      'dev.browser.inspect',
      {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        targetId: target.id,
        selector,
      },
      { kind: 'browser_lane', id: lane.id, generation: lane.generation }
    )
      .then((value) => {
        if (requestId !== latestInspectionRequest) return
        const currentLane = activeLane()
        const currentTarget = activePageTarget()
        if (
          currentLane?.id !== lane.id ||
          currentLane.generation !== lane.generation ||
          currentTarget?.id !== target.id ||
          inspectionSelector().trim() !== selector
        )
          return
        setInspectionResult({
          laneId: lane.id,
          generation: lane.generation,
          targetId: target.id,
          value,
        })
      })
      .catch((reply) => {
        if (requestId === latestInspectionRequest) setError(commandError(reply))
      })
      .finally(() => {
        if (requestId === latestInspectionRequest) setInspectionBusy(false)
      })
  }

  async function createLane(kind: BrowserLane['kind']): Promise<void> {
    clearScreenshotContext()
    const session = props.runtimeSessionId
    if (!session) {
      setError({ code: 'invalid_state', retryable: false, message: 'no active runtime session' })
      return
    }
    // `profilePolicyId` is REQUIRED by the contract. Omitting it made the
    // strict decoder refuse every lane creation, so `activeLane()` stayed
    // undefined and Take over / Screenshot / Cookies / mini-preview were
    // permanently disabled.
    const policies = await execute<{ items: readonly ProfilePolicy[] }>(
      'dev.browser.profilePolicies',
      {}
    )
    const policy = policies.items[0]
    if (!policy) {
      setError({
        code: 'capability_unavailable',
        retryable: false,
        message: 'no browser profile policy is available on this host',
      })
      return
    }
    execute<BrowserLane>('dev.browser.laneCreate', {
      profilePolicyId: policy.id,
      runtimeSessionId: session,
      kind,
    })
      .then((lane) => {
        setError(undefined)
        setActiveLaneId(lane.id)
        void refetchLanes()
      })
      .catch((reply) => setError(commandError(reply)))
  }

  function takeoverOrRelease(): void {
    const lane = activeLane()
    if (!lane) return
    invalidateInspection()
    clearScreenshotContext()
    const operation =
      lane.automationOwner === 'human_takeover' ? 'dev.browser.release' : 'dev.browser.takeover'
    execute<BrowserLane>(
      operation,
      {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
      },
      { kind: 'browser_lane', id: lane.id, generation: lane.generation }
    )
      .then(() => {
        setError(undefined)
        void refetchLanes()
      })
      .catch((reply) => setError(commandError(reply)))
  }

  function screenshot(): void {
    const context = screenshotContext()
    const lane = activeLane()
    const target = activePageTarget()
    const currentScope = scope()
    if (!context.canCapture || !lane || !target || !currentScope || !screenshotMounted) return

    const requestId = ++latestScreenshotRequest
    setScreenshotBusy(true)
    setScreenshotError(undefined)
    const requestContextKey = screenshotContextKey(context)
    const stillCurrent = (): boolean => {
      return (
        screenshotMounted &&
        requestId === latestScreenshotRequest &&
        sameScreenshotContext(context, screenshotContext())
      )
    }

    execute<ScreenshotRef>(
      'dev.browser.screenshot',
      {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        targetId: target.id,
        format: 'png',
      },
      { kind: 'browser_lane', id: lane.id, generation: lane.generation }
    )
      .then((reference) => {
        if (!stillCurrent()) return
        if (
          typeof reference.redacted !== 'boolean' ||
          browserScopeKey(reference.scope) !== browserScopeKey(currentScope)
        )
          throw new Error('screenshot reply is missing valid scope or redaction provenance')
        setScreenshotResult({ reference, contextKey: requestContextKey, runtime: context.runtime })
        setError(undefined)
      })
      .catch((reply) => {
        if (stillCurrent()) setScreenshotError(commandError(reply))
      })
      .finally(() => {
        if (stillCurrent()) setScreenshotBusy(false)
      })
  }

  /**
   * Applies the selected responsive preset to the active lane through
   * `dev.browser.viewport`; the runtime state is authoritative, so the pane
   * only reflects failures as typed errors.
   */
  function applyResponsivePreset(
    nextPreset: ResponsivePresetId,
    nextOrientation: ResponsiveOrientation,
    nextZoomScale = 1
  ): void {
    invalidateInspection()
    clearScreenshotContext()
    const lane = activeLane()
    if (!lane) return
    const viewport = resolvePresetViewport(presetById(nextPreset), nextOrientation)
    const width = Math.round(viewport.width * nextZoomScale)
    const height = Math.round(viewport.height * nextZoomScale)
    const requestId = (latestViewportRequests.get(lane.id) ?? 0) + 1
    latestViewportRequests.set(lane.id, requestId)
    execute<BrowserLane>(
      'dev.browser.viewport',
      {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        width,
        height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: viewport.mobile,
      },
      { kind: 'browser_lane', id: lane.id, generation: lane.generation }
    )
      .then(() => {
        if (requestId !== latestViewportRequests.get(lane.id)) return
        const currentLane = lanes()?.items.find((item) => item.id === lane.id)
        if (currentLane?.generation !== lane.generation) return
        setAppliedViewports((current) =>
          new Map(current).set(lane.id, {
            laneId: lane.id,
            generation: lane.generation,
            presetId: nextPreset,
            orientation: nextOrientation,
            zoomScale: nextZoomScale,
            width,
            height,
            deviceScaleFactor: viewport.deviceScaleFactor,
            mobile: viewport.mobile,
          })
        )
        if (activeLane()?.id === lane.id) setError(undefined)
      })
      .catch(async (reply) => {
        if (requestId !== latestViewportRequests.get(lane.id)) return
        const failure = commandError(reply)
        const revisionBeforeRefresh = errorRevision
        if (failure.code === 'stale_generation') {
          try {
            await refetchLanes()
          } catch {
            // Keep the original typed command error if the lane refresh fails.
          }
        }
        if (requestId !== latestViewportRequests.get(lane.id)) return
        if (errorRevision !== revisionBeforeRefresh) return
        const currentLane = lanes()?.items.find((item) => item.id === lane.id)
        if (activeLane()?.id !== lane.id) return
        if (currentLane?.generation === lane.generation) {
          setError(failure)
        }
      })
  }

  function screenshotContext(): ScreenshotContext {
    const currentRuntime = runtime()
    const currentScope = currentRuntime.preferenceScope?.()
    const lane = activeLane()
    const target = activePageTarget()
    const viewport = viewportForActiveLane()
    const currentScopeKey = browserScopeKey(currentScope)
    const laneScopeKey = browserScopeKey(lane?.scope)
    const scopeMatches = currentScopeKey !== undefined && laneScopeKey === currentScopeKey
    const sessionMatches =
      !props.runtimeSessionId || lane?.runtimeSessionId === props.runtimeSessionId

    return {
      runtime: currentRuntime,
      runtimeStatus: currentRuntime.state().status,
      scopeKey: currentScopeKey,
      requestedSessionId: props.runtimeSessionId,
      laneId: lane?.id,
      laneScopeKey,
      laneSessionId: lane?.runtimeSessionId,
      laneGeneration: lane?.generation,
      targetId: target?.id,
      targetUrl: target?.url,
      targetTitle: target?.title,
      targetType: target?.type,
      viewportKey: JSON.stringify(viewport ?? null),
      canCapture:
        currentRuntime.state().status === 'ready' &&
        Boolean(lane && scopeMatches && sessionMatches && target && !targets.loading),
    }
  }

  function clearScreenshotContext(): void {
    latestScreenshotRequest += 1
    setScreenshotBusy(false)
    setScreenshotResult(undefined)
    setScreenshotError(undefined)
  }

  let previousScreenshotContext: ScreenshotContext | undefined
  createEffect(() => {
    const next = screenshotContext()
    if (previousScreenshotContext && !sameScreenshotContext(previousScreenshotContext, next)) {
      const runtimeContextChanged =
        previousScreenshotContext.runtime !== next.runtime ||
        previousScreenshotContext.scopeKey !== next.scopeKey ||
        previousScreenshotContext.requestedSessionId !== next.requestedSessionId
      clearScreenshotContext()
      if (runtimeContextChanged) void refetchLanes()
    }
    previousScreenshotContext = next
  })

  onCleanup(() => {
    screenshotMounted = false
    latestScreenshotRequest += 1
  })

  function handleUrlKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      setUrlDraft(currentUrl())
      setUrlFocused(false)
      if (event.currentTarget instanceof HTMLElement) event.currentTarget.blur()
      return
    }
    const submission = resolveAnnotationSubmission(event)
    if (submission === 'attach' || submission === 'send') {
      event.preventDefault()
      submitUrl()
    }
  }

  const availability = () => runtime().state()
  const unavailabilityReason = () => {
    const state = runtime().state()
    return state.status === 'unavailable' ? state.reason : 'loading'
  }

  return (
    <section class="dev-browser" aria-label="Browser">
      <div class="dev-browser__chrome" role="toolbar" aria-label="Browser navigation">
        <div class="dev-browser__nav-group" role="group" aria-label="Navigation">
          <ActionButton
            type="button"
            variant="outline"
            size="icon-sm"
            tooltip="Reload"
            aria-label="Reload"
            disabled={!activeLane() || !currentUrl()}
            onClick={reloadCurrentPage}
          >
            <RotateCw aria-hidden="true" />
          </ActionButton>
        </div>
        <form
          class="dev-browser__url"
          onSubmit={(event) => {
            event.preventDefault()
            submitUrl()
          }}
        >
          <Input
            type="url"
            placeholder="Search or enter URL"
            spellcheck={false}
            aria-label="URL"
            value={urlFocused() ? urlDraft() : currentUrl()}
            onFocus={() => {
              setUrlDraft(currentUrl())
              setUrlFocused(true)
            }}
            onBlur={() => setUrlFocused(false)}
            onKeyDown={handleUrlKeyDown}
          />
        </form>
        <ActionButton
          type="button"
          variant="outline"
          size="icon-sm"
          tooltip="Screenshot"
          aria-label="Screenshot"
          aria-busy={screenshotBusy()}
          disabled={!screenshotContext().canCapture || screenshotBusy()}
          onClick={screenshot}
        >
          <Camera aria-hidden="true" />
        </ActionButton>
        <ActionButton
          type="button"
          variant="outline"
          size="icon-sm"
          tooltip={miniPreviewOpen() ? 'Close floating preview' : 'Float preview'}
          aria-label={miniPreviewOpen() ? 'Close floating preview' : 'Float preview'}
          aria-pressed={miniPreviewOpen()}
          onClick={() => setMiniPreviewOpen((value) => !value)}
        >
          <PictureInPicture2 aria-hidden="true" />
        </ActionButton>
        <ActionButton
          type="button"
          variant="outline"
          size="icon-sm"
          tooltip={cookiesOpen() ? 'Close cookie import' : 'Import cookies'}
          aria-label={cookiesOpen() ? 'Close cookie import' : 'Import cookies'}
          aria-pressed={cookiesOpen()}
          disabled={!activeLane()}
          onClick={() => setCookiesOpen((value) => !value)}
        >
          <Cookie aria-hidden="true" />
        </ActionButton>
        <ActionButton
          type="button"
          variant="outline"
          size="icon-sm"
          tooltip="Close browser pane"
          aria-label="Close browser pane"
          onClick={() => {
            setCookiesOpen(false)
            setMiniPreviewOpen(false)
          }}
        >
          <X aria-hidden="true" />
        </ActionButton>
      </div>

      <div class="dev-browser__identity" role="status">
        <Show when={activeLane()} fallback={<span class="dev-terminal-muted">No active lane</span>}>
          {(lane) => (
            <>
              <strong>{LANE_KIND_LABEL[lane().kind]}</strong>
              <span>profile {lane().profileId.slice(0, 18)}…</span>
              <span>node {lane().scope.runtimeNodeId.slice(0, 8)}</span>
              <span>owner {lane().automationOwner}</span>
              <span>gen {lane().generation}</span>
              <span
                class={cn('dev-status-dot', {
                  'dev-status-dot--active': lane().automationOwner !== 'none',
                })}
                aria-hidden="true"
              />
            </>
          )}
        </Show>
      </div>

      <Show
        when={availability().status === 'ready'}
        fallback={
          <p class="dev-empty-state">Browser lanes are unavailable: {unavailabilityReason()}</p>
        }
      >
        <div class="dev-browser__menu">
          <Show when={error()}>
            {(shown) => (
              <p class="dev-terminal-muted" role="alert">
                {shown().code}: {shown().message}
              </p>
            )}
          </Show>
          <Show when={screenshotError()}>
            {(shown) => (
              <p class="dev-terminal-muted" role="alert" aria-label="Screenshot error">
                {shown().code}: {shown().message}
              </p>
            )}
          </Show>
          <Show when={screenshotBusy() && !screenshotResult()}>
            <p role="status" aria-label="Screenshot capture">
              Capturing screenshot…
            </p>
          </Show>
          <Show
            when={(() => {
              const result = screenshotResult()
              const context = screenshotContext()
              return result &&
                result.runtime === context.runtime &&
                result.contextKey === screenshotContextKey(context)
                ? result
                : undefined
            })()}
          >
            {(state) => (
              <div
                class="dev-browser__inspection-result"
                role="status"
                aria-label="Screenshot result"
                aria-busy={screenshotBusy()}
              >
                <strong>Screenshot reference</strong>
                <span>Reference: {state().reference.id}</span>
                <span>
                  Dimensions: {state().reference.width} × {state().reference.height}
                </span>
                <span>Content type: {state().reference.contentType}</span>
                <span>Expires: {state().reference.expiresAt}</span>
                <span>Redacted: {String(state().reference.redacted)}</span>
                <Show when={screenshotBusy()}>
                  <span>Capturing a newer screenshot…</span>
                </Show>
              </div>
            )}
          </Show>

          <p class="dev-browser__section-title">Lanes</p>
          <div role="tablist" aria-label="Browser lanes">
            <For each={lanes()?.items ?? []}>
              {(lane) => (
                <Button
                  type="button"
                  role="tab"
                  aria-selected={lane.id === activeLane()?.id}
                  class={cn('dev-browser__row', {
                    'dev-utility-tab--selected': lane.id === activeLane()?.id,
                  })}
                  onClick={() => {
                    invalidateInspection()
                    clearScreenshotContext()
                    setActiveLaneId(lane.id)
                    void refetchTargets()
                    void refetchDiagnostics()
                  }}
                >
                  <span class="dev-browser__row-main">
                    <span>{LANE_KIND_LABEL[lane.kind]}</span>
                    <span class="dev-browser__row-meta">
                      {lane.state} · takeover {lane.automationOwner}
                    </span>
                  </span>
                </Button>
              )}
            </For>
            <Show when={(lanes()?.items.length ?? 0) === 0}>
              <div class="dev-browser__row">
                <span class="dev-terminal-muted">No lanes yet — create one to start.</span>
              </div>
            </Show>
          </div>
          <div class="dev-browser__actions">
            <For each={['human_embedded', 'task_owned', 'user_context'] as const}>
              {(kind) => (
                <Button type="button" variant="outline" size="sm" onClick={() => createLane(kind)}>
                  New {LANE_KIND_LABEL[kind]}
                </Button>
              )}
            </For>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!activeLane() || activeLane()?.kind === 'human_embedded'}
              onClick={takeoverOrRelease}
            >
              {activeLane()?.automationOwner === 'human_takeover'
                ? 'Release capture (Esc)'
                : 'Take over'}
            </Button>
          </div>

          <p class="dev-browser__section-title">Ports</p>
          <For each={portRows()}>
            {(row) => (
              <Button
                type="button"
                class="dev-browser__row"
                disabled={!portNavigationRequest(row)}
                onClick={() => {
                  const request = portNavigationRequest(row)
                  if (!request) return
                  setActiveLaneId(request.lane.id)
                  setUrlFocused(false)
                  dispatchNavigation(request)
                }}
              >
                <span class="dev-browser__row-main">
                  <span>{row.processName ?? 'Listening'}</span>
                  <span class="dev-browser__row-meta">
                    {row.host}:{row.port} · {row.owner}
                    {row.health === 'stale' ? ' · stale' : ''}
                  </span>
                </span>
                <span
                  class={cn('dev-row-badge', {
                    'dev-row-badge--success': isPreviewableRow(row),
                    'dev-row-badge--failure': row.health === 'stale',
                  })}
                >
                  {row.owner === 'adea' ? 'preview' : 'external'}
                </span>
              </Button>
            )}
          </For>

          <p class="dev-browser__section-title">Targets</p>
          <For each={targets()?.items ?? []}>
            {(target) => (
              <div class="dev-browser__row">
                <span class="dev-browser__row-main">
                  <span>{target.title || target.url}</span>
                  <span class="dev-browser__row-meta">{target.type}</span>
                </span>
              </div>
            )}
          </For>

          <p class="dev-browser__section-title">Inspect</p>
          <form class="dev-browser__inspect" onSubmit={inspectSelector}>
            <Label class="dev-browser__inspect-label" for="dev-browser-inspection-selector">
              CSS selector
            </Label>
            <Input
              id="dev-browser-inspection-selector"
              type="text"
              aria-label="CSS selector"
              maxLength={512}
              autocomplete="off"
              spellcheck={false}
              value={inspectionSelector()}
              onInput={(event) => {
                setInspectionSelector(event.currentTarget.value)
                invalidateInspection()
              }}
            />
            <p class="dev-browser__row-meta">
              Queries the active page by selector; this does not pick from the preview.
            </p>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={
                !activeLane() ||
                !activePageTarget() ||
                targets.loading ||
                inspectionSelector().trim().length === 0 ||
                inspectionSelector().trim().length > 512 ||
                inspectionBusy()
              }
            >
              {inspectionBusy() ? 'Inspecting…' : 'Inspect selector'}
            </Button>
          </form>
          <Show
            when={(() => {
              const result = inspectionResult()
              const lane = activeLane()
              const target = activePageTarget()
              return result &&
                lane?.id === result.laneId &&
                lane.generation === result.generation &&
                target?.id === result.targetId
                ? result
                : undefined
            })()}
          >
            {(state) => (
              <div
                class="dev-browser__inspection-result"
                role="status"
                aria-label="Inspection result"
              >
                <Show when={state().value.nodeId} fallback={<span>No matching element.</span>}>
                  <span>
                    {state().value.role ?? 'Element'}
                    {state().value.name ? ` · ${state().value.name}` : ''}
                  </span>
                  <Show when={state().value.bounds}>
                    {(bounds) => (
                      <span>
                        x {bounds().x} · y {bounds().y} · width {bounds().width} · height{' '}
                        {bounds().height}
                      </span>
                    )}
                  </Show>
                </Show>
              </div>
            )}
          </Show>

          <p class="dev-browser__section-title">Responsive</p>
          <div class="dev-browser__actions">
            <For each={RESPONSIVE_PRESETS}>
              {(preset) => (
                <Button
                  type="button"
                  class={cn('dev-button', {
                    'dev-utility-tab--selected': preset.id === viewportForActiveLane()?.presetId,
                  })}
                  aria-pressed={preset.id === viewportForActiveLane()?.presetId}
                  disabled={!activeLane()}
                  onClick={() => applyResponsivePreset(preset.id, preset.defaultOrientation)}
                >
                  {preset.label}
                </Button>
              )}
            </For>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!activeLane()}
              onClick={() => {
                const current = viewportForActiveLane()
                const next: ResponsiveOrientation =
                  current?.orientation === 'portrait' || !current ? 'landscape' : 'portrait'
                applyResponsivePreset(current?.presetId ?? 'responsive', next, current?.zoomScale)
              }}
            >
              Rotate
            </Button>
            <ActionButton
              type="button"
              variant="outline"
              size="icon-sm"
              tooltip="Zoom out"
              aria-label="Zoom out"
              disabled={!activeLane()}
              onClick={() => {
                const current = viewportForActiveLane()
                const scale = Math.max(0.5, Math.round(((current?.zoomScale ?? 1) - 0.1) * 10) / 10)
                applyResponsivePreset(
                  current?.presetId ?? 'responsive',
                  current?.orientation ?? 'portrait',
                  scale
                )
              }}
            >
              −
            </ActionButton>
            <span class="dev-browser__row-meta">
              {Math.round((viewportForActiveLane()?.zoomScale ?? 1) * 100)}%
            </span>
            <ActionButton
              type="button"
              variant="outline"
              size="icon-sm"
              tooltip="Zoom in"
              aria-label="Zoom in"
              disabled={!activeLane()}
              onClick={() => {
                const current = viewportForActiveLane()
                const scale = Math.min(2, Math.round(((current?.zoomScale ?? 1) + 0.1) * 10) / 10)
                applyResponsivePreset(
                  current?.presetId ?? 'responsive',
                  current?.orientation ?? 'portrait',
                  scale
                )
              }}
            >
              +
            </ActionButton>
            <Show
              when={viewportForActiveLane()}
              fallback={
                <span class="dev-browser__row-meta">Select a preset to set the viewport.</span>
              }
            >
              {(viewport) => (
                <span class="dev-browser__row-meta">
                  CSS viewport {viewport().width} × {viewport().height} · DPR{' '}
                  {viewport().deviceScaleFactor} · UA {viewport().mobile ? 'mobile' : 'desktop'}
                </span>
              )}
            </Show>
          </div>

          <p class="dev-browser__section-title">Diagnostics</p>
          <div class="dev-browser__diagnostics" aria-label="Console and network diagnostics">
            <For each={diagnostics()?.items ?? []}>
              {(entry) => (
                <div class="dev-browser__diagnostic" data-level={entry.level}>
                  <span class="dev-browser__row-meta">{entry.category}</span>
                  <span>{entry.message}</span>
                </div>
              )}
            </For>
            <Show when={(diagnostics()?.items.length ?? 0) === 0}>
              <span class="dev-terminal-muted">No console or network events.</span>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={cookiesOpen() && activeLane()}>
        <CookieImportPanel
          laneId={activeLane()!.id}
          generation={activeLane()!.generation}
          run={execute}
          onClose={() => setCookiesOpen(false)}
        />
      </Show>

      <Show when={miniPreviewOpen()}>
        <MiniPreview lane={activeLane()} onClose={() => setMiniPreviewOpen(false)} />
      </Show>
    </section>
  )
}
