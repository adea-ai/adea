/*
 * Browser pane: the right-side Browser/Devices utility's browser half.
 *
 * Composition (toolbar order, URL bar draft semantics, annotate/screenshot/
 * mini-preview toggles, zoom and profile menu) is substantially translated
 * from t3code's PreviewChromeRow/PreviewMoreMenu/ThreadPreviewMiniPlayer
 * (MIT, revision 77bca8b2d76a1f42552e5eee7d277fcb1160347a) to Solid; the
 * lane identity strip implements the Dev Runtime spec's lane display rules.
 * Every host interaction rides DevRuntimeService commands — no desktop
 * imports, and unavailable capability renders as typed states. See NOTICE
 * and docs/research/dev-view-donor-audit.md.
 */
import type { BrowserLane, BrowserTarget, DevError, PortRecord } from '@adea-ai/types/dev-runtime'
import '@adea-ai/ui/dev-view.css'
import { cn } from '@adea-ai/ui/lib/utils'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Cookie,
  ExternalLink,
  MousePointerClick,
  PictureInPicture2,
  RotateCw,
  X,
} from 'lucide-solid'
import { For, Show, createResource, createSignal } from 'solid-js'

import './browser-pane.css'
import type { DevRuntimeService } from '../platform'
import { resolveAnnotationSubmission, resolveAnnotationShortcut } from './annotation-model'
import { buildDevCommand } from './command'
import { CookieImportPanel } from './cookie-import-panel'
import { isPreviewableRow, mergeServers, type PreviewableServer } from './ports-model'
import { MiniPreview } from './mini-preview'
import {
  presetById,
  resolvePresetViewport,
  RESPONSIVE_PRESETS,
  type ResponsiveOrientation,
  type ResponsivePresetId,
} from './responsive-presets'

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
  const [error, setError] = createSignal<DevError | undefined>(undefined)
  const [urlDraft, setUrlDraft] = createSignal('')
  const [urlFocused, setUrlFocused] = createSignal(false)
  const [annotating, setAnnotating] = createSignal(false)
  const [miniPreviewOpen, setMiniPreviewOpen] = createSignal(false)
  const [cookiesOpen, setCookiesOpen] = createSignal(false)
  const [presetId, setPresetId] = createSignal<ResponsivePresetId>('responsive')
  const [orientation, setOrientation] = createSignal<ResponsiveOrientation>('portrait')
  const [zoomScale, setZoomScale] = createSignal(1)

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

  const [targets, { refetch: refetchTargets }] = createResource(activeLane, async (lane) => {
    if (!lane) return { items: [] as BrowserTarget[] }
    return execute<TargetsPage>(
      'dev.browser.targets',
      { browserLaneId: lane.id, expectedGeneration: lane.generation },
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

  function currentUrl(): string {
    const target = targets()?.items[0]
    return target?.url ?? ''
  }

  function submitUrl(): void {
    const value = urlFocused() ? urlDraft().trim() : ''
    setUrlFocused(false)
    if (!value) return
    const lane = activeLane()
    if (!lane) return
    execute<{
      browserLaneId: string
      targetId: string
      finalUrl: string
      status?: number
    }>(
      'dev.browser.navigate',
      {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        url: value,
      },
      { kind: 'browser_lane', id: lane.id, generation: lane.generation }
    )
      .then(() => {
        setError(undefined)
        void refetchTargets()
      })
      .catch((reply) => setError(commandError(reply)))
  }

  function createLane(kind: BrowserLane['kind']): void {
    const session = props.runtimeSessionId
    if (!session) {
      setError({ code: 'invalid_state', retryable: false, message: 'no active runtime session' })
      return
    }
    execute<BrowserLane>('dev.browser.laneCreate', { runtimeSessionId: session, kind })
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
    const lane = activeLane()
    if (!lane) return
    execute<unknown>(
      'dev.browser.screenshot',
      {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        format: 'png',
      },
      { kind: 'browser_lane', id: lane.id, generation: lane.generation }
    )
      .then(() => {
        setError(undefined)
      })
      .catch((reply) => setError(commandError(reply)))
  }

  /**
   * Applies the selected responsive preset to the active lane through
   * `dev.browser.viewport`; the runtime state is authoritative, so the pane
   * only reflects failures as typed errors.
   */
  function applyResponsivePreset(
    nextPreset: ResponsivePresetId,
    nextOrientation: ResponsiveOrientation
  ): void {
    setPresetId(nextPreset)
    setOrientation(nextOrientation)
    const lane = activeLane()
    if (!lane) return
    const viewport = resolvePresetViewport(presetById(nextPreset), nextOrientation)
    execute<BrowserLane>(
      'dev.browser.viewport',
      {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: viewport.mobile,
      },
      { kind: 'browser_lane', id: lane.id, generation: lane.generation }
    )
      .then(() => setError(undefined))
      .catch((reply) => setError(commandError(reply)))
  }

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

  function handleAnnotationShortcuts(event: KeyboardEvent): void {
    if (!annotating()) return
    const shortcut = resolveAnnotationShortcut(event)
    if (shortcut?.kind === 'cancel') setAnnotating(false)
  }

  const availability = () => runtime().state()
  const unavailabilityReason = () => {
    const state = runtime().state()
    return state.status === 'unavailable' ? state.reason : 'loading'
  }

  return (
    <section
      class={cn('dev-browser', { 'dev-browser__annotation-active': annotating() })}
      aria-label="Browser"
      onKeyDown={handleAnnotationShortcuts}
    >
      <div class="dev-browser__chrome" role="toolbar" aria-label="Browser navigation">
        <div class="dev-browser__nav-group" role="group" aria-label="Navigation">
          <button
            type="button"
            class="dev-icon-button"
            aria-label="Back"
            disabled={!activeLane()}
            onClick={() => refetchTargets()}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            class="dev-icon-button"
            aria-label="Forward"
            disabled={!activeLane()}
            onClick={() => refetchTargets()}
          >
            <ArrowRight aria-hidden="true" />
          </button>
          <button
            type="button"
            class="dev-icon-button"
            aria-label="Reload"
            disabled={!activeLane()}
            onClick={() => refetchTargets()}
          >
            <RotateCw aria-hidden="true" />
          </button>
        </div>
        <form
          class="dev-browser__url"
          onSubmit={(event) => {
            event.preventDefault()
            submitUrl()
          }}
        >
          <input
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
        <button
          type="button"
          class="dev-icon-button"
          aria-label="Open in system browser"
          disabled={!currentUrl()}
        >
          <ExternalLink aria-hidden="true" />
        </button>
        <button
          type="button"
          class="dev-icon-button"
          aria-label={annotating() ? 'Cancel annotation' : 'Annotate preview'}
          aria-pressed={annotating()}
          onClick={() => setAnnotating((value) => !value)}
        >
          <MousePointerClick aria-hidden="true" />
        </button>
        <button
          type="button"
          class="dev-icon-button"
          aria-label="Screenshot"
          disabled={!activeLane()}
          onClick={screenshot}
        >
          <Camera aria-hidden="true" />
        </button>
        <button
          type="button"
          class="dev-icon-button"
          aria-label={miniPreviewOpen() ? 'Close floating preview' : 'Float preview'}
          aria-pressed={miniPreviewOpen()}
          onClick={() => setMiniPreviewOpen((value) => !value)}
        >
          <PictureInPicture2 aria-hidden="true" />
        </button>
        <button
          type="button"
          class="dev-icon-button"
          aria-label={cookiesOpen() ? 'Close cookie import' : 'Import cookies'}
          aria-pressed={cookiesOpen()}
          disabled={!activeLane()}
          onClick={() => setCookiesOpen((value) => !value)}
        >
          <Cookie aria-hidden="true" />
        </button>
        <button
          type="button"
          class="dev-icon-button"
          aria-label="Close browser pane"
          onClick={() => {
            setCookiesOpen(false)
            setMiniPreviewOpen(false)
          }}
        >
          <X aria-hidden="true" />
        </button>
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

          <p class="dev-browser__section-title">Lanes</p>
          <div role="tablist" aria-label="Browser lanes">
            <For each={lanes()?.items ?? []}>
              {(lane) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={lane.id === activeLane()?.id}
                  class={cn('dev-browser__row', {
                    'dev-utility-tab--selected': lane.id === activeLane()?.id,
                  })}
                  onClick={() => {
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
                </button>
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
                <button type="button" class="dev-button" onClick={() => createLane(kind)}>
                  New {LANE_KIND_LABEL[kind]}
                </button>
              )}
            </For>
            <button
              type="button"
              class="dev-button"
              disabled={!activeLane() || activeLane()?.kind === 'human_embedded'}
              onClick={takeoverOrRelease}
            >
              {activeLane()?.automationOwner === 'human_takeover'
                ? 'Release capture (Esc)'
                : 'Take over'}
            </button>
          </div>

          <p class="dev-browser__section-title">Ports</p>
          <For each={portRows()}>
            {(row) => (
              <button
                type="button"
                class="dev-browser__row"
                disabled={!isPreviewableRow(row)}
                onClick={() => {
                  if (row.preview) setActiveLaneId(row.preview.browserLaneId)
                  setUrlDraft(row.requestedUrl)
                  submitUrl()
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
              </button>
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

          <p class="dev-browser__section-title">Responsive</p>
          <div class="dev-browser__actions">
            <For each={RESPONSIVE_PRESETS}>
              {(preset) => (
                <button
                  type="button"
                  class={cn('dev-button', {
                    'dev-utility-tab--selected': preset.id === presetId(),
                  })}
                  aria-pressed={preset.id === presetId()}
                  onClick={() => applyResponsivePreset(preset.id, preset.defaultOrientation)}
                >
                  {preset.label}
                </button>
              )}
            </For>
            <button
              type="button"
              class="dev-button"
              onClick={() => {
                const next: ResponsiveOrientation =
                  orientation() === 'portrait' ? 'landscape' : 'portrait'
                setOrientation(next)
                applyResponsivePreset(presetId(), next)
              }}
            >
              Rotate
            </button>
            <button
              type="button"
              class="dev-icon-button"
              aria-label="Zoom out"
              onClick={() =>
                setZoomScale((value) => Math.max(0.5, Math.round((value - 0.1) * 10) / 10))
              }
            >
              −
            </button>
            <span class="dev-browser__row-meta">{Math.round(zoomScale() * 100)}%</span>
            <button
              type="button"
              class="dev-icon-button"
              aria-label="Zoom in"
              onClick={() =>
                setZoomScale((value) => Math.min(2, Math.round((value + 0.1) * 10) / 10))
              }
            >
              +
            </button>
            <span class="dev-browser__row-meta">
              {Math.round(
                resolvePresetViewport(presetById(presetId()), orientation()).width * zoomScale()
              )}
              ×
              {Math.round(
                resolvePresetViewport(presetById(presetId()), orientation()).height * zoomScale()
              )}{' '}
              · UA {presetById(presetId()).mobile ? 'mobile emulation' : 'desktop'}
            </span>
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
