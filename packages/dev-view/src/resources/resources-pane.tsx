/*
 * Copyright (c) 2026 Adea contributors.
 *
 * Runtime resources (#424, machine-wide resources): one sheet for memory,
 * CPU, ports, and storage. The top is an overview of the machine and what
 * Adea uses of it, then an attention banner when something can be cleaned
 * up, then three tabs — Servers & apps, Storage, Agents & usage. Server
 * details, the clean-up review, and resource settings are drill-in views
 * inside the same sheet.
 *
 * The sheet decides nothing about ownership or protection: every destructive
 * action is a host plan/commit pair shown in a confirmation first, rows the
 * host did not mark actionable have no action, and an unobserved value stays
 * unknown rather than zero. Unavailable capability renders as typed states.
 */
import type {
  ResourcePreferences,
  ResourcePreferencesInput,
  ResourceSnapshot,
  UsageRecord,
  Worktree,
  WorktreeStorageRecord,
} from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { RefreshCw, SlidersHorizontal, Sparkles, TriangleAlert } from 'lucide-solid'
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from 'solid-js'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@adea-ai/ui/components/ui/tabs'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

import type { DevRuntimeService } from '../platform'
import { buildDevCommand } from '../browser/command'
import { SegmentBar, Sparkline, Swatch } from './resources-charts'
import { CleanupReview } from './resources-cleanup'
import { ServerDetail } from './resources-detail'
import { usageCards } from './resources-model'
import { ServersTab } from './resources-servers'
import { ResourceSettings } from './resources-settings'
import { StorageTab } from './resources-storage'
import { commandError, StopDialog, type StopIntent } from './resources-stop-dialog'
import { UsageTab } from './resources-usage'
import {
  attentionSummary,
  cleanupCandidates,
  FALLBACK_PREFERENCES,
  formatPercent,
  formatSize,
  isResourcePreferences,
  memoryBreakdown,
  preferencesInput,
  serverGroups,
  storageRows,
  storageTotals,
  type ServerRow,
} from './resources-view-model'
import './resources-pane.css'

export type ResourcesPaneProps = {
  runtime: DevRuntimeService
  runtimeSessionId?: string
}

type View =
  | { kind: 'main' }
  | { kind: 'detail'; rowId: string }
  | { kind: 'cleanup' }
  | { kind: 'settings' }

type Page<T> = { items?: readonly T[] }

const MAX_CPU_POINTS = 30

export function ResourcesPane(props: ResourcesPaneProps) {
  const runtime = () => props.runtime
  const scope = () => runtime().preferenceScope?.()
  const serviceReady = () => runtime().state().status === 'ready'

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

  const [view, setView] = createSignal<View>({ kind: 'main' })
  const [tab, setTab] = createSignal<'servers' | 'storage' | 'usage'>('servers')
  const [notice, setNotice] = createSignal<string>()
  const [actionError, setActionError] = createSignal<string>()
  const [stopIntent, setStopIntent] = createSignal<StopIntent>()

  // ── Data ──────────────────────────────────────────────────────────────
  const [snapshot, { refetch: refetchSnapshot }] = createResource(serviceReady, async (ready) => {
    if (!ready) return undefined
    return execute<ResourceSnapshot>('dev.resources.snapshot', {})
  })
  const [usage, { refetch: refetchUsage }] = createResource(serviceReady, async (ready) => {
    if (!ready) return { items: [] as readonly UsageRecord[] }
    return execute<Page<UsageRecord>>('dev.resources.usage', {})
  })
  const [storedPreferences, { mutate: setStoredPreferences }] = createResource(
    serviceReady,
    async (ready) => {
      if (!ready) return undefined
      try {
        const value = await execute<unknown>('dev.resources.preferences', {})
        return isResourcePreferences(value) ? value : undefined
      } catch {
        return undefined
      }
    }
  )
  const [worktrees, { refetch: refetchWorktrees }] = createResource(serviceReady, async (ready) => {
    if (!ready) return [] as readonly Worktree[]
    try {
      const page = await execute<Page<Worktree>>('dev.worktree.list', { limit: 500 })
      return Array.isArray(page?.items) ? page.items : []
    } catch {
      return [] as readonly Worktree[]
    }
  })
  const [storageWanted, setStorageWanted] = createSignal(false)
  const [storage, { refetch: refetchStorage }] = createResource(
    () => (serviceReady() && storageWanted() ? true : undefined),
    async () => {
      try {
        const page = await execute<Page<WorktreeStorageRecord>>('dev.resources.worktreeStorage', {
          limit: 500,
        })
        return Array.isArray(page?.items) ? page.items : undefined
      } catch {
        return undefined
      }
    }
  )

  const preferences = (): ResourcePreferencesInput => {
    const stored = storedPreferences()
    return stored ? preferencesInput(stored) : FALLBACK_PREFERENCES
  }

  // Storage is measured lazily: ask for it when the tab or the review needs it.
  createEffect(() => {
    if (tab() === 'storage' || view().kind === 'cleanup') setStorageWanted(true)
  })

  // Visible sampling: poll while the sheet is open and the page is visible.
  createEffect(() => {
    if (!serviceReady()) return
    const seconds = Math.max(2, preferences().sampling.visibleSeconds)
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (snapshot.loading || stopIntent()) return
      void refetchSnapshot()
      const records = storage()
      if (storageWanted() && records?.some((record) => record.state !== 'measured'))
        void refetchStorage()
    }, seconds * 1000)
    onCleanup(() => clearInterval(timer))
  })

  const refresh = () => {
    void refetchSnapshot()
    void refetchUsage()
    void refetchWorktrees()
    if (storageWanted()) void refetchStorage()
  }

  // ── Derived ───────────────────────────────────────────────────────────
  const current = () => snapshot.latest
  const groups = createMemo(() =>
    serverGroups({
      snapshot: current(),
      worktrees: worktrees.latest ?? [],
      alerts: preferences().alerts,
    })
  )
  const machine = () => current()?.machine
  const memory = createMemo(() => memoryBreakdown(groups(), machine()))
  const storageList = createMemo(() => storageRows(worktrees.latest ?? [], storage.latest ?? []))
  const totals = createMemo(() => storageTotals(storageList(), current()?.retainedData ?? []))
  const candidates = createMemo(() =>
    preferences().cleanup.mode === 'off'
      ? []
      : cleanupCandidates({
          groups: groups(),
          worktrees: worktrees.latest ?? [],
          storage: storageList(),
          preferences: preferences(),
        })
  )
  const attention = createMemo(() => attentionSummary(candidates(), groups()))
  const rows = createMemo(() => groups().flatMap((group) => group.rows))
  const listenerCount = () =>
    (current()?.ports.filter((port) => port.state === 'observed').length ?? 0) +
    (current()
      ?.foreign?.filter((record) => record.listeningPorts.length > 0)
      .reduce((sum, record) => sum + record.listeningPorts.length, 0) ?? 0)
  const adeaCpu = createMemo(() => {
    const values = rows()
      .filter((row) => row.kind === 'owned' || row.record.attribution.kind === 'adea_terminal')
      .map((row) => row.cpuPercent)
      .filter((value): value is number => value !== undefined)
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined
  })
  const [cpuHistory, setCpuHistory] = createSignal<readonly number[]>([])
  createEffect(() => {
    const value = machine()?.cpuPercent
    if (value === undefined) return
    setCpuHistory((points) => [...points, value].slice(-MAX_CPU_POINTS))
  })
  const foreignNote = () => {
    const snap = current()
    if (!snap) return undefined
    if (preferences().coverage === 'adea')
      return 'Showing only what Adea started. Turn on Whole machine in settings to see everything else.'
    if (snap.foreign === undefined)
      return 'Processes Adea didn’t start aren’t available on this runtime.'
    return undefined
  }
  const detailRow = () => {
    const selected = view()
    if (selected.kind !== 'detail') return undefined
    return rows().find((row) => row.id === selected.rowId)
  }

  // ── Actions ───────────────────────────────────────────────────────────
  const openStop = (row: ServerRow) => {
    setActionError(undefined)
    setStopIntent({ mode: 'stop', row })
  }
  const openRestart = (row: ServerRow) => {
    setActionError(undefined)
    setStopIntent({ mode: 'restart', row })
  }
  const actionDone = (message: string) => {
    setStopIntent(undefined)
    setNotice(message)
    void refetchSnapshot()
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const [savingSettings, setSavingSettings] = createSignal(false)
  const [settingsError, setSettingsError] = createSignal<string>()
  const [draft, setDraft] = createSignal<ResourcePreferencesInput>()
  const settingsValue = () => draft() ?? preferences()
  onCleanup(() => clearTimeout(saveTimer))
  function changeSettings(next: ResourcePreferencesInput): void {
    setDraft(next)
    setSettingsError(undefined)
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void saveSettings(next), 400)
  }
  async function saveSettings(next: ResourcePreferencesInput): Promise<void> {
    const stored = storedPreferences()
    if (!stored) return
    setSavingSettings(true)
    try {
      const saved = await execute<ResourcePreferences>('dev.resources.preferencesUpdate', {
        expectedVersion: stored.version,
        preferences: next,
      })
      if (isResourcePreferences(saved)) setStoredPreferences(saved)
      setDraft(undefined)
      void refetchSnapshot()
    } catch (error) {
      const failure = commandError(error)
      setSettingsError(
        failure.code === 'stale_version'
          ? 'Settings changed somewhere else; showing the latest.'
          : failure.message
      )
      setDraft(undefined)
      try {
        const latest = await execute<unknown>('dev.resources.preferences', {})
        if (isResourcePreferences(latest)) setStoredPreferences(latest)
      } catch {
        // Keep what is shown; the error explains why it did not save.
      }
    } finally {
      setSavingSettings(false)
    }
  }

  return (
    <div class="dev-resources" role="region" aria-label="Runtime resources">
      <div class="dev-resources__header">
        <div class="dev-resources__row-main">
          <div class="dev-resources__title-row">
            <span class="dev-resources__title">Runtime resources</span>
            <ActionButton
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh resources"
              tooltip={
                serviceReady()
                  ? 'Refresh runtime resources'
                  : 'Connect a runtime to refresh resources'
              }
              disabled={!serviceReady()}
              onClick={refresh}
            >
              <RefreshCw aria-hidden="true" />
            </ActionButton>
          </div>
          <span class="dev-resources__row-detail">
            {preferences().coverage === 'machine' ? 'This machine' : 'Adea only'}
            <Show when={current()}> · sampled every {preferences().sampling.visibleSeconds} s</Show>
          </span>
        </div>
        <span class="dev-resources__header-actions">
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Resource settings"
            tooltip={
              serviceReady()
                ? 'Alerts, clean-up, and protected processes'
                : 'Connect a runtime to change resource settings'
            }
            disabled={!serviceReady()}
            aria-pressed={view().kind === 'settings'}
            onClick={() =>
              setView(view().kind === 'settings' ? { kind: 'main' } : { kind: 'settings' })
            }
          >
            <SlidersHorizontal aria-hidden="true" />
          </ActionButton>
        </span>
      </div>

      <Show
        when={serviceReady()}
        fallback={<p class="dev-resources__unavailable">Runtime unavailable</p>}
      >
        <Show when={snapshot.error && !current()}>
          <p class="dev-resources__error" role="alert">
            {commandError(snapshot.error).message}
          </p>
        </Show>
        <Show
          when={current()}
          fallback={
            <Show when={!snapshot.error}>
              <p class="dev-resources__note">Loading…</p>
            </Show>
          }
        >
          <Show when={notice()}>
            {(message) => (
              <p class="dev-resources__notice" role="status">
                {message()}
              </p>
            )}
          </Show>
          <Show when={actionError()}>
            {(message) => (
              <p class="dev-resources__error" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <Switch>
            <Match when={view().kind === 'settings'}>
              <ResourceSettings
                preferences={settingsValue()}
                editable={storedPreferences() !== undefined}
                saving={savingSettings()}
                {...(settingsError() ? { error: settingsError() } : {})}
                onChange={changeSettings}
                onBack={() => setView({ kind: 'main' })}
              />
            </Match>
            <Match when={view().kind === 'cleanup'}>
              <CleanupReview
                candidates={candidates()}
                run={execute}
                mode={preferences().cleanup.mode}
                onBack={() => setView({ kind: 'main' })}
                onStopForeign={openStop}
                onOpenSettings={() => setView({ kind: 'settings' })}
                onFinished={(message) => {
                  setNotice(message)
                  setView({ kind: 'main' })
                  refresh()
                }}
              />
            </Match>
            <Match when={detailRow()}>
              {(row) => (
                <ServerDetail
                  row={row()}
                  busy={stopIntent() !== undefined}
                  onBack={() => setView({ kind: 'main' })}
                  onStop={openStop}
                  onRestart={openRestart}
                />
              )}
            </Match>
            <Match when={true}>
              <div class="dev-resources__hero">
                <div class="dev-resources__hero-line">
                  <span class="dev-resources__hero-value">{formatSize(memory().adeaBytes)}</span>
                  <span class="dev-resources__row-detail">used by Adea</span>
                  <span class="dev-resources__spacer" />
                  <Show when={memory().totalBytes !== undefined}>
                    <span class="dev-resources__row-detail">
                      Machine memory {formatSize(memory().usedBytes)} of{' '}
                      {formatSize(memory().totalBytes)}
                    </span>
                  </Show>
                </div>
                <Show when={memory().totalBytes !== undefined}>
                  <SegmentBar
                    label={`Memory: Adea ${formatSize(memory().adeaBytes)}, elsewhere ${formatSize(memory().elsewhereBytes)}, other apps ${formatSize(memory().otherBytes)}, free ${formatSize(memory().freeBytes)}`}
                    parts={[
                      { value: memory().adeaBytes, tone: 'adea' },
                      { value: memory().elsewhereBytes, tone: 'elsewhere' },
                      { value: memory().otherBytes, tone: 'other' },
                      { value: memory().freeBytes, tone: 'free' },
                    ]}
                  />
                  <div class="dev-resources__legend">
                    <span class="dev-resources__legend-item">
                      <Swatch tone="adea" />
                      Adea{' '}
                      <span class="dev-resources__legend-value">
                        {formatSize(memory().adeaBytes)}
                      </span>
                    </span>
                    <span class="dev-resources__legend-item">
                      <Swatch tone="elsewhere" />
                      Listed elsewhere{' '}
                      <span class="dev-resources__legend-value">
                        {formatSize(memory().elsewhereBytes)}
                      </span>
                    </span>
                    <span class="dev-resources__legend-item">
                      <Swatch tone="other" />
                      Other apps{' '}
                      <span class="dev-resources__legend-value">
                        {formatSize(memory().otherBytes)}
                      </span>
                    </span>
                    <span class="dev-resources__legend-item">
                      <Swatch tone="free" />
                      Free{' '}
                      <span class="dev-resources__legend-value">
                        {formatSize(memory().freeBytes)}
                      </span>
                    </span>
                  </div>
                </Show>
              </div>

              <div class="dev-resources__tiles">
                <div class="dev-resources__tile">
                  <span class="dev-resources__row-detail">CPU (Adea)</span>
                  <span class="dev-resources__tile-line">
                    <span class="dev-resources__tile-value">{formatPercent(adeaCpu())}</span>
                    <Sparkline values={cpuHistory()} tone="cpu" />
                  </span>
                  <span class="dev-resources__row-detail">
                    Machine {formatPercent(machine()?.cpuPercent)}
                  </span>
                </div>
                <div class="dev-resources__tile">
                  <span class="dev-resources__row-detail">Ports</span>
                  <span class="dev-resources__tile-value">{listenerCount()}</span>
                  <span class="dev-resources__row-detail">
                    {current()?.ports.filter((port) => port.owner === 'adea').length ?? 0} Adea
                  </span>
                </div>
                <div class="dev-resources__tile">
                  <span class="dev-resources__row-detail">Storage (Adea)</span>
                  <span class="dev-resources__tile-value">{formatSize(totals().totalBytes)}</span>
                  <span class="dev-resources__row-detail">
                    <Show when={machine()?.diskFreeBytes} fallback="Open Storage to measure">
                      {formatSize(Number(machine()?.diskFreeBytes))} free on disk
                    </Show>
                  </span>
                </div>
              </div>

              <Show
                when={
                  attention().count > 0 ||
                  attention().leaking.length > 0 ||
                  attention().foreignCount > 0
                }
              >
                <div class="dev-resources__attention" role="status">
                  <TriangleAlert
                    class="dev-resources__icon dev-resources__icon--warning"
                    aria-hidden="true"
                  />
                  <span class="dev-resources__row-main">
                    <span class="dev-resources__row-title">
                      <Show
                        when={attention().count > 0}
                        fallback={`${attention().leaking.length + attention().foreignCount} ${attention().leaking.length + attention().foreignCount === 1 ? 'thing needs' : 'things need'} a look`}
                      >
                        {attention().count} {attention().count === 1 ? 'thing' : 'things'} can be
                        cleaned up
                        <Show when={attention().diskBytes}>
                          {' '}
                          · frees about {formatSize(attention().diskBytes)}
                        </Show>
                      </Show>
                    </span>
                    <span class="dev-resources__row-detail">
                      <For each={attention().leaking.slice(0, 2)}>
                        {(row, index) => (
                          <>
                            {index() > 0 ? ' · ' : ''}
                            {row.title} is{' '}
                            {row.leak.kind === 'growing'
                              ? 'leaking memory'
                              : 'over your memory limit'}
                          </>
                        )}
                      </For>
                      <Show when={attention().leaking.length === 0}>
                        {attention().foreignCount > 0
                          ? `${attention().foreignCount} ${attention().foreignCount === 1 ? 'process' : 'processes'} not started by Adea ${attention().foreignCount === 1 ? 'is' : 'are'} holding ports`
                          : 'Review before anything is stopped or deleted'}
                      </Show>
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setView({ kind: 'cleanup' })}
                  >
                    Review
                  </Button>
                </div>
              </Show>

              <Tabs
                value={tab()}
                onChange={(value) => setTab(value as 'servers' | 'storage' | 'usage')}
              >
                <TabsList aria-label="Resources">
                  <TabsTrigger value="servers">
                    Servers &amp; apps
                    <Badge variant="outline" size="sm">
                      {rows().length}
                    </Badge>
                  </TabsTrigger>
                  <TabsTrigger value="storage">Storage</TabsTrigger>
                  <TabsTrigger value="usage">Agents &amp; usage</TabsTrigger>
                </TabsList>
                <TabsContent value="servers">
                  <ServersTab
                    groups={groups()}
                    {...(foreignNote() ? { foreignNote: foreignNote() } : {})}
                    actions={{
                      busy: stopIntent() !== undefined,
                      onDetails: (row) => setView({ kind: 'detail', rowId: row.id }),
                      onStop: openStop,
                      onRestart: openRestart,
                    }}
                  />
                </TabsContent>
                <TabsContent value="storage">
                  <StorageTab
                    rows={storageList()}
                    totals={totals()}
                    retained={current()?.retainedData ?? []}
                    available={storage.latest !== undefined || storage.loading}
                    {...(machine()?.diskFreeBytes !== undefined
                      ? { diskFreeBytes: Number(machine()?.diskFreeBytes) }
                      : {})}
                  />
                </TabsContent>
                <TabsContent value="usage">
                  <UsageTab cards={usageCards(usage.latest?.items ?? [], Date.now())} />
                </TabsContent>
              </Tabs>

              <div class="dev-resources__footer">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={preferences().cleanup.mode === 'off'}
                  onClick={() => setView({ kind: 'cleanup' })}
                >
                  <Sparkles aria-hidden="true" />
                  Clean up
                  <Show when={attention().count > 0}>
                    <Badge variant="default" size="sm">
                      {attention().count}
                    </Badge>
                  </Show>
                </Button>
                <span class="dev-resources__row-detail">
                  {preferences().cleanup.mode === 'off'
                    ? 'Clean-up suggestions are off'
                    : 'Clean-up asks first · processes Adea didn’t start are never stopped automatically'}
                </span>
              </div>
            </Match>
          </Switch>
        </Show>
      </Show>

      <StopDialog
        intent={stopIntent()}
        run={execute}
        onClose={() => setStopIntent(undefined)}
        onDone={actionDone}
      />
    </div>
  )
}
