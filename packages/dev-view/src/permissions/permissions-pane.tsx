/*
 * macOS permissions pane (issue #471). Status pane + actions pattern
 * translated from Orca's DeveloperPermissionsPane.tsx (MIT, revision
 * 403b62a8) to Solid, Adea's token layer, and the typed capability contract:
 * statuses arrive only from the injected probe service (real host probes in
 * the desktop lane, typed-unavailable everywhere else — never fixtures), a
 * re-check reflects System Settings changes within one interaction (donor
 * focus-refresh semantics, single-flight, no polling), and every denied or
 * unprobed row degrades honestly with its exact System Settings deep link.
 * See NOTICE and docs/research/dev-view-donor-audit.md.
 */
import { Button } from '@adea-ai/ui/components/ui/button'
import { RefreshCw } from 'lucide-solid'
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'

import type { MacPermissionId, MacPermissionReport } from '@adea-ai/types/desktop-permissions'

import {
  actionsFor,
  groupPermissions,
  presentPermission,
  snapshotSummary,
  stateChangeAnnouncement,
} from './model'
import { createUnavailableMacPermissionsService, type MacPermissionsPageService } from './service'
import './permissions-pane.css'

export function PermissionsPane(props: { service?: MacPermissionsPageService }) {
  // The unavailable service keeps the web-only dev mode truthful: every row
  // renders typed `capability_unavailable`, never a guessed status.
  const unavailable = createUnavailableMacPermissionsService()
  const service = () => props.service ?? unavailable
  const [snapshot, setSnapshot] = createSignal<readonly MacPermissionReport[]>()
  const [hostPlatform, setHostPlatform] = createSignal<'macos' | 'other' | 'unknown'>('unknown')
  const [busy, setBusy] = createSignal(true)
  const [pending, setPending] = createSignal<string>()
  const [bridgeReachable, setBridgeReachable] = createSignal(true)
  const [announcement, setAnnouncement] = createSignal('')

  // Donor refresh-sequence semantics: only the latest probe may paint or
  // announce, so a slow earlier probe can never overwrite a newer answer.
  let refreshSequence = 0
  let previousStates = new Map<MacPermissionId, MacPermissionReport>()

  const announceStateDifferences = (reports: readonly MacPermissionReport[]) => {
    for (const report of reports) {
      const message = stateChangeAnnouncement(previousStates.get(report.id), report)
      if (message) {
        setAnnouncement(message)
        break
      }
    }
  }

  const refresh = async (options?: Readonly<{ force?: boolean }>) => {
    const token = ++refreshSequence
    setBusy(true)
    try {
      const next = await service().snapshot({ force: options?.force ?? false })
      if (token !== refreshSequence) return
      announceStateDifferences(next.permissions)
      previousStates = new Map(next.permissions.map((report) => [report.id, report]))
      setSnapshot(next.permissions)
      setHostPlatform(next.hostPlatform)
      setBridgeReachable(true)
    } catch {
      if (token !== refreshSequence) return
      // A failed re-check over an existing snapshot keeps the last real
      // answer (each row carries its probe time); an empty pane renders the
      // typed-unavailable fallback and says the shell did not answer.
      setBridgeReachable(false)
      if (!snapshot()) {
        const fallback = await unavailable.snapshot()
        if (token !== refreshSequence) return
        setSnapshot(fallback.permissions)
      }
      setAnnouncement('Could not re-check permissions; the desktop shell did not answer.')
    } finally {
      if (token === refreshSequence) setBusy(false)
    }
  }

  const request = (meta: { id: MacPermissionId; title: string }) => {
    setPending(meta.id)
    setAnnouncement(`Requesting ${meta.title}; macOS may show a consent prompt.`)
    void refresh({ force: true }).finally(() => {
      if (pending() === meta.id) setPending(undefined)
    })
  }

  const openSettings = (meta: { id: MacPermissionId; title: string }) => {
    setPending(meta.id)
    void service()
      .openSettings(meta.id)
      .then(() => setAnnouncement(`System Settings opened for ${meta.title}.`))
      .catch(() =>
        setAnnouncement(`Could not open System Settings for ${meta.title} from this lane.`)
      )
      .finally(() => {
        if (pending() === meta.id) setPending(undefined)
      })
  }

  // Donor window-focus refresh: flipping a permission in System Settings and
  // switching back updates the pane within one interaction. Tied to focus,
  // never a polling interval, so the pane does not nag or spin while idle.
  onMount(() => {
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    onCleanup(() => window.removeEventListener('focus', onFocus))
  })

  const groups = () =>
    groupPermissions({
      hostPlatform: hostPlatform(),
      permissions: snapshot() ?? [],
      probedAt: '',
    })

  const summaryText = () =>
    snapshotSummary({
      hostPlatform: hostPlatform(),
      permissions: snapshot() ?? [],
      probedAt: '',
    })

  return (
    <section class="dev-permissions" aria-label="macOS permissions" aria-busy={busy()}>
      {/* The polite live region carries every status change and action
          outcome; it is visually hidden because the pane's chips and hints
          carry the same information on screen. */}
      <p class="visually-hidden" role="status" aria-live="polite">
        {announcement()}
      </p>
      <div class="dev-permissions__header">
        <p class="dev-permissions__summary">{summaryText()}</p>
        {/* aria-disabled rather than disabled: the button keeps keyboard
            focus while a re-check runs (WCAG focus-management), and the
            handler guards re-entry. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={busy()}
          onClick={() => {
            if (!busy()) void refresh({ force: true })
          }}
        >
          <RefreshCw aria-hidden="true" />
          {busy() ? 'Checking…' : 'Check again'}
        </Button>
      </div>
      <Show when={!bridgeReachable()}>
        <p class="dev-permissions__notice" role="note">
          The desktop shell is not connected, so permission states cannot be checked in this lane.
          No status below is a guess.
        </p>
      </Show>
      <For each={groups()}>
        {(group) => (
          <div
            class="dev-permissions__group"
            role="group"
            aria-labelledby={`dev-permissions-${group.id}`}
          >
            <h3 class="dev-permissions__group-heading" id={`dev-permissions-${group.id}`}>
              {group.heading}
            </h3>
            <For each={group.rows}>
              {(row) => {
                const presentation = () => presentPermission(row.report)
                const degraded = () =>
                  row.report.state === 'denied' || row.report.state === 'not_determined'
                return (
                  <div class="dev-permissions__row" data-permission={row.meta.id}>
                    <div class="dev-permissions__identity">
                      <div class="dev-permissions__title-line">
                        <h4 class="dev-permissions__title">{row.meta.title}</h4>
                        <span class="dev-permissions__status" data-tone={presentation().tone}>
                          {presentation().label}
                        </span>
                      </div>
                      <p class="dev-permissions__purpose">{row.meta.purpose}</p>
                      <p
                        class="dev-permissions__consequence"
                        data-active={degraded() ? 'true' : 'false'}
                      >
                        {degraded() ? 'Without it: ' : 'If denied: '}
                        {row.meta.consequence}
                      </p>
                      <Show when={presentation().hint}>
                        <p class="dev-permissions__hint">{presentation().hint}</p>
                      </Show>
                    </div>
                    <div class="dev-permissions__actions">
                      <For each={actionsFor(row.report)}>
                        {(action) => (
                          <Button
                            type="button"
                            variant={action.kind === 'request' ? 'default' : 'outline'}
                            size="sm"
                            aria-disabled={pending() !== undefined}
                            onClick={() => {
                              if (pending() !== undefined) return
                              if (action.kind === 'request') request(row.meta)
                              else openSettings(row.meta)
                            }}
                          >
                            {action.label}
                          </Button>
                        )}
                      </For>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        )}
      </For>
    </section>
  )
}
