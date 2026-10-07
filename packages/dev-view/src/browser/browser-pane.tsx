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
  BrowserAnnotation,
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
import { Camera, Cookie, PictureInPicture2, RotateCw, SquarePen, X } from 'lucide-solid'
import { For, Show, createEffect, createResource, createSignal, onCleanup } from 'solid-js'

import './browser-pane.css'
import type { DevRuntimeService } from '../platform'
import {
  createDevUtilityFenceSource,
  devUtilityContextKey,
  DevUtilityContextChangedError,
  hasDevUtilitySession,
  isDevUtilityContextChanged,
  sameDevUtilityScope,
  type DevUtilityContextReader,
  type DevUtilityFence,
} from '../utility-context'
import { executeDevUtilityCommand, readDevUtilityCommand } from '../utility-command'
import { resolveAnnotationSubmission } from './annotation-model'
import {
  MAX_NOTE_LENGTH,
  NUDGE_FINE_STEP,
  type AnnotationDraft,
  type AnnotationPoint,
  type AnnotationRectDraft,
  type AnnotationSurfaceTool,
  annotationDisabledReason,
  annotationRequest,
  describeAnnotationResult,
  describeDraft,
  dragRegion,
  isRegionSubmittable,
  nudgeRegion,
} from './annotation-surface-model'
import { CookieImportPanel } from './cookie-import-panel'
import {
  buildBrowserNavigationRequest,
  buildPortNavigationRequest,
  type BrowserNavigationRequest,
} from './navigation-model'
import { isPreviewableRow, mergeServers, type PreviewableServer } from './ports-model'
import { MiniPreview } from './mini-preview'
import { LANE_KIND_LABEL } from './lane-kind-label'
import {
  presetById,
  resolvePresetViewport,
  RESPONSIVE_PRESETS,
  type ResponsiveOrientation,
  type ResponsivePresetId,
} from './responsive-presets'
import { AnnotationSurface } from '@adea-ai/ui/components/ui/annotation-surface'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ListRowControl } from '@adea-ai/ui/components/composites/list-row'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'

export type BrowserPaneProps = {
  context: DevUtilityContextReader
}

type LanePage = { contextKey?: string; items: readonly BrowserLane[]; nextCursor?: string }
type TargetsPage = { contextKey?: string; items: readonly BrowserTarget[] }
type PortsPage = { contextKey?: string; items: readonly PortRecord[] }
type DiagnosticsPage = {
  contextKey?: string
  laneId?: string
  laneGeneration?: number
  items: readonly { id: string; level: string; category: string; message: string }[]
}
type ScreenshotContext = {
  runtime: DevRuntimeService
  runtimeStatus: string
  contextRevision: number
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
    context.contextRevision,
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
  const utilityContext = () => props.context()
  const runtime = () => utilityContext().runtime
  const scope = () => utilityContext().scope
  const fences = createDevUtilityFenceSource(utilityContext)
  onCleanup(() => fences.dispose())
  const [activeLaneId, setActiveLaneId] = createSignal<string | undefined>(undefined)
  const [paneError, writeError] = createSignal<DevError | undefined>(undefined)
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

  // ── Annotation frame (#718) ────────────────────────────────────────────────
  // The surface is pixel-free by spec: the region is normalized viewport
  // geometry, and the host captures the screenshot when the annotation is
  // submitted, binding the reply's screenshotId to the frame it captured.
  const [annotateMode, setAnnotateMode] = createSignal(false)
  const [annotateTool, setAnnotateTool] = createSignal<AnnotationSurfaceTool>('region')
  const [regionDraft, setRegionDraft] = createSignal<AnnotationRectDraft>()
  const [dragPoints, setDragPoints] = createSignal<{
    start: AnnotationPoint
    current: AnnotationPoint
  }>()
  const [noteAnchor, setNoteAnchor] = createSignal<AnnotationPoint>()
  const [noteText, setNoteText] = createSignal('')
  const [annotationResult, setAnnotationResult] = createSignal<BrowserAnnotation>()
  const [annotationError, setAnnotationError] = createSignal<DevError>()
  const [annotationBusy, setAnnotationBusy] = createSignal(false)
  const [annotationInteractionEpoch, setAnnotationInteractionEpoch] = createSignal(0)
  let latestAnnotationRequest = 0
  let annotateButtonRef: HTMLButtonElement | undefined

  const liveRegion = (): AnnotationRectDraft | undefined => {
    const drag = dragPoints()
    return drag ? dragRegion(drag.start, drag.current) : regionDraft()
  }

  const activeDraft = (): AnnotationDraft | undefined => {
    if (annotateTool() === 'region') return liveRegion()
    const anchor = noteAnchor()
    const text = noteText().trim()
    return anchor && text.length > 0 ? { kind: 'text', ...anchor, text } : undefined
  }

  const annotateReason = () =>
    annotationDisabledReason({
      serviceReady: runtime().state().status === 'ready',
      targetsLoading: targets.loading,
      hasLane: Boolean(activeLane()),
      laneState: activeLane()?.state,
      laneKind: activeLane()?.kind,
      automationOwner: activeLane()?.automationOwner,
      hasPageTarget: Boolean(activePageTarget()),
    })

  function clearAnnotationDraft(): void {
    latestAnnotationRequest += 1
    setAnnotationInteractionEpoch((epoch) => epoch + 1)
    setAnnotationBusy(false)
    setDragPoints(undefined)
    setRegionDraft(undefined)
    setNoteAnchor(undefined)
    setNoteText('')
    setAnnotationError(undefined)
  }

  function exitAnnotateMode(): void {
    clearAnnotationDraft()
    setAnnotateMode(false)
    annotateButtonRef?.focus()
  }

  function handleSurfaceKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (activeDraft() || noteAnchor()) {
        clearAnnotationDraft()
        return
      }
      exitAnnotateMode()
      return
    }
    // Escape can retire a pending draft; other keys cannot alter its geometry.
    if (annotationBusy() || annotateReason()) return
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void submitAnnotation()
      return
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault()
        setAnnotateTool('region')
        return
      }
      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault()
        setAnnotateTool('note')
        return
      }
    }
    const draft = regionDraft()
    if (!draft || !event.key.startsWith('Arrow')) return
    const key = event.key.slice('Arrow'.length).toLowerCase()
    if (key !== 'up' && key !== 'down' && key !== 'left' && key !== 'right') return
    event.preventDefault()
    setRegionDraft(
      nudgeRegion(draft, key, {
        resize: event.shiftKey,
        step: event.altKey ? NUDGE_FINE_STEP : undefined,
      })
    )
  }

  function toggleAnnotateMode(): void {
    if (annotateMode()) {
      exitAnnotateMode()
      return
    }
    clearAnnotationDraft()
    setAnnotateMode(true)
  }

  function submitAnnotation(): void {
    const lane = activeLane()
    const target = activePageTarget()
    const draft = activeDraft()
    const fence = captureSessionFence()
    if (
      !fence ||
      !fence.isCurrent() ||
      annotationBusy() ||
      !lane ||
      !target ||
      !draft ||
      lane.runtimeSessionId !== fence.context.runtimeSessionId ||
      !sameDevUtilityScope(lane.scope, fence.context.scope) ||
      annotateReason()
    )
      return
    const request = annotationRequest({ lane, target, draft })
    const requestId = ++latestAnnotationRequest
    setAnnotationBusy(true)
    setAnnotationError(undefined)
    executeDevUtilityCommand<BrowserAnnotation>(
      fence,
      request.operation,
      request.body,
      request.resource
    )
      .then((value) => {
        if (requestId !== latestAnnotationRequest || !fence.isCurrent()) return
        const currentLane = activeLane()
        const currentTarget = activePageTarget()
        if (
          currentLane?.id !== lane.id ||
          currentLane.generation !== lane.generation ||
          currentLane.runtimeSessionId !== fence.context.runtimeSessionId ||
          !sameDevUtilityScope(currentLane.scope, fence.context.scope)
        )
          return
        if (
          currentTarget?.id !== target.id ||
          currentTarget.generation !== target.generation ||
          currentTarget.url !== target.url
        )
          return
        setAnnotationResult(value)
        clearAnnotationDraft()
      })
      .catch((reply) => {
        if (
          requestId === latestAnnotationRequest &&
          fence.isCurrent() &&
          !isDevUtilityContextChanged(reply)
        )
          setAnnotationError(commandError(reply))
      })
      .finally(() => {
        if (requestId === latestAnnotationRequest) setAnnotationBusy(false)
      })
  }

  // A pending annotation belongs to one runtime and authoritative context.
  // Equivalent resource refreshes retain the draft; A-to-B-to-A retires replies.
  // The context epoch keeps a Dev→Chat→Dev roundtrip from reviving a draft the
  // spec requires a view switch to invalidate.
  let previousAnnotationContext: { runtime: DevRuntimeService; key: string } | undefined
  createEffect(() => {
    const currentRuntime = runtime()
    const key = JSON.stringify([
      browserScopeKey(scope()),
      utilityContext().runtimeSessionId,
      utilityContext().revision,
      currentRuntime.state().status,
      activeLane()?.id,
      activeLane()?.generation,
      activeLane()?.state,
      activeLane()?.automationOwner,
      activePageTarget()?.id,
      activePageTarget()?.url,
    ])
    if (
      previousAnnotationContext?.runtime === currentRuntime &&
      previousAnnotationContext.key === key
    )
      return
    previousAnnotationContext = { runtime: currentRuntime, key }
    clearAnnotationDraft()
    setAnnotationResult(undefined)
  })

  function captureSessionFence(): DevUtilityFence | undefined {
    return fences.capture('session')
  }

  const utilityContextKey = () => {
    const current = utilityContext()
    return current.runtime.state().status === 'ready' && hasDevUtilitySession(current)
      ? devUtilityContextKey(current)
      : undefined
  }
  const [lanes, { refetch: refetchLanes }] = createResource(
    utilityContextKey,
    async (key): Promise<LanePage> => {
      const fence = captureSessionFence()
      if (!key || !fence || devUtilityContextKey(fence.context) !== key)
        return { items: [] as BrowserLane[] }
      const page = await readDevUtilityCommand<LanePage>(fence, 'dev.browser.lanes', {
        runtimeSessionId: fence.context.runtimeSessionId!,
      })
      if (!page) return { items: [] as BrowserLane[] }
      return {
        ...page,
        contextKey: key,
        items: page.items.filter(
          (lane) =>
            lane.runtimeSessionId === fence.context.runtimeSessionId &&
            sameDevUtilityScope(lane.scope, fence.context.scope)
        ),
      }
    }
  )

  const activeLane = () => {
    const current = utilityContext()
    if (!hasDevUtilitySession(current)) return undefined
    const page = lanes()
    const items = page && page.contextKey === utilityContextKey() ? page.items : []
    const scoped = items.filter(
      (lane) =>
        lane.runtimeSessionId === current.runtimeSessionId &&
        sameDevUtilityScope(lane.scope, current.scope)
    )
    return scoped.find((lane) => lane.id === activeLaneId()) ?? scoped[0]
  }

  const laneItems = () =>
    lanes()?.contextKey === utilityContextKey() ? (lanes()?.items ?? []) : []

  const targetItems = () =>
    targets()?.contextKey === utilityContextKey() ? (targets()?.items ?? []) : []

  const diagnosticItems = () => {
    const lane = activeLane()
    const page = diagnostics()
    return lane &&
      page &&
      page.contextKey === utilityContextKey() &&
      page.laneId === lane.id &&
      page.laneGeneration === lane.generation
      ? page.items
      : []
  }

  const activePageTarget = () => {
    const lane = activeLane()
    if (!lane) return undefined
    const page = targets()
    if (!page || page.contextKey !== utilityContextKey()) return undefined
    return page.items.find(
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

  const [targets, { refetch: refetchTargets }] = createResource(
    () => {
      const key = utilityContextKey()
      const lane = activeLane()
      return key && lane ? JSON.stringify([key, lane.id, lane.generation]) : undefined
    },
    async (key): Promise<TargetsPage> => {
      const lane = activeLane()
      const fence = captureSessionFence()
      if (
        !key ||
        !lane ||
        !fence ||
        lane.runtimeSessionId !== fence.context.runtimeSessionId ||
        !sameDevUtilityScope(lane.scope, fence.context.scope) ||
        key !== JSON.stringify([devUtilityContextKey(fence.context), lane.id, lane.generation])
      )
        return { items: [] as BrowserTarget[] }
      // The contract carries generation in the resource binding, not the body.
      const page = await readDevUtilityCommand<TargetsPage>(
        fence,
        'dev.browser.targets',
        { browserLaneId: lane.id },
        { kind: 'browser_lane', id: lane.id, generation: lane.generation }
      )
      if (!page) return { items: [] as BrowserTarget[] }
      return {
        ...page,
        contextKey: devUtilityContextKey(fence.context),
        items: page.items.filter(
          (target) => target.browserLaneId === lane.id && target.generation === lane.generation
        ),
      }
    }
  )

  const [ports] = createResource(utilityContextKey, async (key): Promise<PortsPage> => {
    const fence = captureSessionFence()
    if (!key || !fence || devUtilityContextKey(fence.context) !== key)
      return { items: [] as PortRecord[] }
    // The Ports menu consumes the read-only port projection; ownership
    // comes from the host's launch records, never from the scan itself.
    const page = await readDevUtilityCommand<PortsPage>(fence, 'dev.resources.ports', {
      runtimeSessionId: fence.context.runtimeSessionId!,
    })
    if (!page) return { items: [] as PortRecord[] }
    return {
      ...page,
      contextKey: key,
      items: page.items.filter(
        (port) =>
          port.runtimeSessionId === fence.context.runtimeSessionId &&
          sameDevUtilityScope(port.scope, fence.context.scope)
      ),
    }
  })

  const [diagnostics, { refetch: refetchDiagnostics }] = createResource(
    () => {
      const key = utilityContextKey()
      const lane = activeLane()
      return key && lane ? JSON.stringify([key, lane.id, lane.generation]) : undefined
    },
    async (key): Promise<DiagnosticsPage> => {
      const lane = activeLane()
      const fence = captureSessionFence()
      if (
        !key ||
        !lane ||
        !fence ||
        lane.runtimeSessionId !== fence.context.runtimeSessionId ||
        !sameDevUtilityScope(lane.scope, fence.context.scope) ||
        key !== JSON.stringify([devUtilityContextKey(fence.context), lane.id, lane.generation])
      )
        return { items: [] as DiagnosticsPage['items'] }
      const page = await readDevUtilityCommand<DiagnosticsPage>(
        fence,
        'dev.browser.diagnostics',
        { browserLaneId: lane.id, expectedGeneration: lane.generation },
        { kind: 'browser_lane', id: lane.id, generation: lane.generation }
      )
      return {
        ...(page ?? { items: [] as DiagnosticsPage['items'] }),
        contextKey: devUtilityContextKey(fence.context),
        laneId: lane.id,
        laneGeneration: lane.generation,
      }
    }
  )

  const portRows = (): readonly PreviewableServer[] =>
    mergeServers({
      scanner: (ports()?.contextKey === utilityContextKey() ? (ports()?.items ?? []) : [])
        .filter(
          (port) =>
            port.runtimeSessionId === utilityContext().runtimeSessionId &&
            sameDevUtilityScope(port.scope, utilityContext().scope)
        )
        .map((port) => ({
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
    buildPortNavigationRequest(row, laneItems(), activeLane())

  function currentUrl(): string {
    return activePageTarget()?.url ?? ''
  }

  function dispatchNavigation(request: BrowserNavigationRequest): void {
    const fence = captureSessionFence()
    if (!fence) return
    invalidateInspection()
    clearScreenshotContext()
    executeDevUtilityCommand<{
      browserLaneId: string
      targetId: string
      finalUrl: string
      status?: number
    }>(fence, request.operation, request.body, request.resource)
      .then(() => {
        if (!fence.isCurrent()) return
        setError(undefined)
        void refetchTargets()
      })
      .catch((reply) => {
        if (fence.isCurrent() && !isDevUtilityContextChanged(reply)) setError(commandError(reply))
      })
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
    const fence = captureSessionFence()
    if (
      !fence ||
      !lane ||
      !target ||
      targets.loading ||
      selector.length === 0 ||
      selector.length > 512
    )
      return

    const requestId = ++latestInspectionRequest
    setInspectionBusy(true)
    setInspectionResult(undefined)
    setError(undefined)
    executeDevUtilityCommand<BrowserInspection>(
      fence,
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
        if (requestId !== latestInspectionRequest || !fence.isCurrent()) return
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
        if (
          requestId === latestInspectionRequest &&
          fence.isCurrent() &&
          !isDevUtilityContextChanged(reply)
        )
          setError(commandError(reply))
      })
      .finally(() => {
        if (requestId === latestInspectionRequest && fence.isCurrent()) setInspectionBusy(false)
      })
  }

  async function createLane(kind: BrowserLane['kind']): Promise<void> {
    const fence = captureSessionFence()
    if (!fence) return
    clearScreenshotContext()
    const session = fence.context.runtimeSessionId!
    // `profilePolicyId` is REQUIRED by the contract. Omitting it made the
    // strict decoder refuse every lane creation, so `activeLane()` stayed
    // undefined and Take over / Screenshot / Cookies / mini-preview were
    // permanently disabled.
    try {
      const policies = await executeDevUtilityCommand<{ items: readonly ProfilePolicy[] }>(
        fence,
        'dev.browser.profilePolicies',
        {}
      )
      if (!fence.isCurrent()) return
      const policy = policies.items.find((item) =>
        sameDevUtilityScope(item.scope, fence.context.scope)
      )
      if (!policy) {
        setError({
          code: 'capability_unavailable',
          retryable: false,
          message: 'no browser profile policy is available on this host',
        })
        return
      }
      await executeDevUtilityCommand<BrowserLane>(fence, 'dev.browser.laneCreate', {
        profilePolicyId: policy.id,
        runtimeSessionId: session,
        kind,
      })
      if (!fence.isCurrent()) return
      setError(undefined)
      void refetchLanes()
    } catch (reply) {
      if (fence.isCurrent() && !isDevUtilityContextChanged(reply)) setError(commandError(reply))
    }
  }

  function takeoverOrRelease(): void {
    const fence = captureSessionFence()
    const lane = activeLane()
    if (!fence || !lane) return
    invalidateInspection()
    clearScreenshotContext()
    const operation =
      lane.automationOwner === 'human_takeover' ? 'dev.browser.release' : 'dev.browser.takeover'
    executeDevUtilityCommand<BrowserLane>(
      fence,
      operation,
      {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
      },
      { kind: 'browser_lane', id: lane.id, generation: lane.generation }
    )
      .then(() => {
        if (!fence.isCurrent()) return
        setError(undefined)
        void refetchLanes()
      })
      .catch((reply) => {
        if (fence.isCurrent() && !isDevUtilityContextChanged(reply)) setError(commandError(reply))
      })
  }

  function screenshot(): void {
    const fence = captureSessionFence()
    if (!fence) return
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
        fence.isCurrent() &&
        requestId === latestScreenshotRequest &&
        sameScreenshotContext(context, screenshotContext())
      )
    }

    executeDevUtilityCommand<ScreenshotRef>(
      fence,
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
        if (stillCurrent() && !isDevUtilityContextChanged(reply))
          setScreenshotError(commandError(reply))
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
    const fence = captureSessionFence()
    const lane = activeLane()
    if (!fence || !lane) return
    const viewport = resolvePresetViewport(presetById(nextPreset), nextOrientation)
    const width = Math.round(viewport.width * nextZoomScale)
    const height = Math.round(viewport.height * nextZoomScale)
    const requestId = (latestViewportRequests.get(lane.id) ?? 0) + 1
    latestViewportRequests.set(lane.id, requestId)
    executeDevUtilityCommand<BrowserLane>(
      fence,
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
        if (requestId !== latestViewportRequests.get(lane.id) || !fence.isCurrent()) return
        const currentLane = laneItems().find((item) => item.id === lane.id)
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
        if (
          requestId !== latestViewportRequests.get(lane.id) ||
          !fence.isCurrent() ||
          isDevUtilityContextChanged(reply)
        )
          return
        const failure = commandError(reply)
        const revisionBeforeRefresh = errorRevision
        if (failure.code === 'stale_generation') {
          try {
            await refetchLanes()
          } catch {
            // Keep the original typed command error if the lane refresh fails.
          }
        }
        if (requestId !== latestViewportRequests.get(lane.id) || !fence.isCurrent()) return
        if (errorRevision !== revisionBeforeRefresh) return
        const currentLane = laneItems().find((item) => item.id === lane.id)
        if (activeLane()?.id !== lane.id) return
        if (currentLane?.generation === lane.generation) {
          setError(failure)
        }
      })
  }

  function screenshotContext(): ScreenshotContext {
    const current = utilityContext()
    const currentRuntime = current.runtime
    const currentScope = current.scope
    const lane = activeLane()
    const target = activePageTarget()
    const viewport = viewportForActiveLane()
    const currentScopeKey = browserScopeKey(currentScope)
    const laneScopeKey = browserScopeKey(lane?.scope)
    const scopeMatches = currentScopeKey !== undefined && laneScopeKey === currentScopeKey
    const sessionMatches = lane?.runtimeSessionId === current.runtimeSessionId

    return {
      runtime: currentRuntime,
      runtimeStatus: currentRuntime.state().status,
      contextRevision: current.revision,
      scopeKey: currentScopeKey,
      requestedSessionId: current.runtimeSessionId,
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
        hasDevUtilitySession(current) &&
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
    latestAnnotationRequest += 1
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
            aria-label="Reload"
            tooltip="Reload the selected browser page."
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
          aria-label="Screenshot"
          tooltip="Capture screenshot metadata for the selected browser page."
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
          aria-label={annotateMode() ? 'Exit annotate mode' : 'Annotate frame'}
          tooltip={
            annotateReason() ?? 'Annotate the current page frame: drag a region or anchor a note.'
          }
          aria-pressed={annotateMode()}
          disabled={Boolean(annotateReason())}
          busy={annotationBusy()}
          busyLabel="Submitting annotation"
          ref={(element) => (annotateButtonRef = element)}
          onClick={toggleAnnotateMode}
        >
          <SquarePen aria-hidden="true" />
        </ActionButton>
        <ActionButton
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={miniPreviewOpen() ? 'Close floating preview' : 'Float preview'}
          tooltip="Toggle the floating browser preview."
          aria-pressed={miniPreviewOpen()}
          onClick={() => setMiniPreviewOpen((value) => !value)}
        >
          <PictureInPicture2 aria-hidden="true" />
        </ActionButton>
        <ActionButton
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={cookiesOpen() ? 'Close cookie import' : 'Import cookies'}
          tooltip="Open or close cookie import for this browser lane."
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
          aria-label="Close browser pane"
          tooltip="Close the browser pane."
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

      <Show when={annotateMode() && activeLane() && activePageTarget()}>
        {(target) => (
          <section class="dev-browser__annotate" aria-label="Annotate frame">
            <p class="dev-browser__section-title">Annotate frame</p>
            <p class="dev-browser__row-meta">
              The frame is viewport geometry, not page pixels: the host captures the screenshot when
              the annotation is submitted.
            </p>
            <AnnotationSurface
              label={`Annotate frame for ${target().url}. Space starts a mark; drag to mark a region; arrow keys adjust; Enter submits; Escape cancels.`}
              tool={annotateTool() === 'region' ? 'region' : 'point'}
              region={annotateTool() === 'region' ? liveRegion() : undefined}
              resetKey={annotationInteractionEpoch()}
              interactive={!annotationBusy() && !annotateReason()}
              hint={
                !activeDraft()
                  ? annotateTool() === 'region'
                    ? 'Drag across the frame or press Space to mark a region.'
                    : 'Click the frame or press Space to anchor a note.'
                  : undefined
              }
              onPoint={(point) => {
                if (screenshotMounted && !annotationBusy() && !annotateReason())
                  setNoteAnchor(point)
              }}
              onDragChange={(drag, phase) => {
                if (!screenshotMounted) return
                if (phase === 'cancel') {
                  setDragPoints(undefined)
                  return
                }
                if (!drag || annotationBusy() || annotateReason()) return
                if (phase === 'end' || phase === 'keyboard') {
                  const region = dragRegion(drag.start, drag.current)
                  setDragPoints(undefined)
                  setRegionDraft(isRegionSubmittable(region) ? region : undefined)
                } else {
                  if (phase === 'start') setRegionDraft(undefined)
                  setDragPoints(drag)
                }
              }}
              onKeyDown={handleSurfaceKeyDown}
            />
            <p class="dev-browser__row-meta" role="status" aria-live="polite">
              {describeDraft(activeDraft())}
            </p>
            <div class="dev-browser__actions">
              <Button
                type="button"
                variant={annotateTool() === 'region' ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={annotateTool() === 'region'}
                disabled={annotationBusy()}
                onClick={() => setAnnotateTool('region')}
              >
                Region (R)
              </Button>
              <Button
                type="button"
                variant={annotateTool() === 'note' ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={annotateTool() === 'note'}
                disabled={annotationBusy()}
                onClick={() => setAnnotateTool('note')}
              >
                Note (N)
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!activeDraft() || annotationBusy()}
                onClick={clearAnnotationDraft}
              >
                Discard draft
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={!activeDraft() || annotationBusy()}
                aria-busy={annotationBusy()}
                onClick={submitAnnotation}
              >
                {annotationBusy() ? 'Submitting…' : 'Submit annotation'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={annotationBusy()}
                onClick={exitAnnotateMode}
              >
                Exit annotate mode (Esc)
              </Button>
            </div>
            <Show when={annotateTool() === 'note'}>
              <div class="dev-browser__annotate-note">
                <Label for="dev-browser-annotation-note">Note text</Label>
                <Input
                  id="dev-browser-annotation-note"
                  type="text"
                  aria-label="Note text"
                  disabled={annotationBusy() || Boolean(annotateReason())}
                  maxLength={MAX_NOTE_LENGTH}
                  autocomplete="off"
                  spellcheck={false}
                  placeholder="Bounded note carried with the annotation"
                  value={noteText()}
                  onInput={(event) => setNoteText(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.isComposing) {
                      event.preventDefault()
                      void submitAnnotation()
                    }
                  }}
                />
              </div>
            </Show>
            <Show when={annotationError()}>
              {(shown) => (
                <p class="dev-terminal-muted" role="alert" aria-label="Annotation error">
                  {shown().code}: {shown().message}
                </p>
              )}
            </Show>
            <Show when={annotationResult()}>
              {(shown) => (
                <p
                  class="dev-browser__inspection-result dev-browser__annotation-result"
                  role="status"
                  aria-label="Annotation result"
                >
                  {describeAnnotationResult(shown())}
                </p>
              )}
            </Show>
          </section>
        )}
      </Show>

      <Show
        when={hasDevUtilitySession(utilityContext())}
        fallback={
          <p class="dev-empty-state" role="status">
            Browser utilities are unavailable until this view is bound to a canonical runtime
            session.
          </p>
        }
      >
        <Show
          when={availability().status === 'ready'}
          fallback={
            <p class="dev-empty-state">Browser lanes are unavailable: {unavailabilityReason()}</p>
          }
        >
          <div class="dev-browser__menu">
            <Show when={paneError()}>
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
            <div role="group" aria-label="Browser lanes">
              <For each={laneItems()}>
                {(lane) => (
                  <ListRowControl
                    as="button"
                    selected={lane.id === activeLane()?.id}
                    description={`${lane.state} · takeover ${lane.automationOwner}`}
                    class="w-full"
                    onClick={() => {
                      invalidateInspection()
                      clearScreenshotContext()
                      setActiveLaneId(lane.id)
                      void refetchTargets()
                      void refetchDiagnostics()
                    }}
                  >
                    {LANE_KIND_LABEL[lane.kind]}
                  </ListRowControl>
                )}
              </For>
              <Show when={laneItems().length === 0}>
                <div class="dev-browser__row">
                  <span class="dev-terminal-muted">No lanes yet — create one to start.</span>
                </div>
              </Show>
            </div>
            <div class="dev-browser__actions">
              <For each={['human_embedded', 'task_owned', 'user_context'] as const}>
                {(kind) => (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => createLane(kind)}
                  >
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
                  variant="ghost"
                  size="sm"
                  class="w-full justify-start"
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
            <For each={targetItems()}>
              {(target) => (
                <div class="dev-browser__row">
                  <span class="dev-browser__row-main">
                    <span class={target.title ? undefined : 'dev-browser__target-url'}>
                      {target.title || target.url}
                    </span>
                    <span class="dev-browser__row-meta">{target.type}</span>
                  </span>
                </div>
              )}
            </For>

            <p class="dev-browser__section-title">Inspect</p>
            <form class="dev-browser__inspect" onSubmit={inspectSelector}>
              <Label for="dev-browser-inspection-selector">CSS selector</Label>
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
                    variant={
                      preset.id === viewportForActiveLane()?.presetId ? 'secondary' : 'outline'
                    }
                    size="sm"
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
                aria-label="Zoom out"
                tooltip="Zoom out the responsive preview."
                disabled={!activeLane()}
                onClick={() => {
                  const current = viewportForActiveLane()
                  const scale = Math.max(
                    0.5,
                    Math.round(((current?.zoomScale ?? 1) - 0.1) * 10) / 10
                  )
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
                aria-label="Zoom in"
                tooltip="Zoom in the responsive preview."
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
              <For each={diagnosticItems()}>
                {(entry) => (
                  <div class="dev-browser__diagnostic" data-level={entry.level}>
                    <span class="dev-browser__row-meta">{entry.category}</span>
                    <span>{entry.message}</span>
                  </div>
                )}
              </For>
              <Show when={diagnosticItems().length === 0}>
                <span class="dev-terminal-muted">No console or network events.</span>
              </Show>
            </div>
          </div>
        </Show>
      </Show>

      <Show when={cookiesOpen() && activeLane()} keyed>
        <CookieImportPanel
          laneId={activeLane()!.id}
          generation={activeLane()!.generation}
          run={(operation, body, resource) => {
            const fence = captureSessionFence()
            const lane = activeLane()
            if (
              !fence ||
              !fence.isCurrent() ||
              !lane ||
              lane.runtimeSessionId !== fence.context.runtimeSessionId ||
              !sameDevUtilityScope(lane.scope, fence.context.scope) ||
              (resource !== undefined &&
                (resource.kind !== 'browser_lane' ||
                  resource.id !== lane.id ||
                  resource.generation !== lane.generation))
            )
              return Promise.reject(new DevUtilityContextChangedError())
            return executeDevUtilityCommand(fence, operation, body, resource)
          }}
          onClose={() => setCookiesOpen(false)}
        />
      </Show>

      <Show when={miniPreviewOpen()}>
        <MiniPreview lane={activeLane()} onClose={() => setMiniPreviewOpen(false)} />
      </Show>
    </section>
  )
}
