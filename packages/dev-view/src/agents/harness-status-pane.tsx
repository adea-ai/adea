/*
 * Agents pane status surface (#400): the session's harness status rendered
 * from the pure model. All state distinctions come from canonical run facts
 * (HarnessRun/AcpConnection through the gate); the pane owns no authority and
 * never fabricates a state — an `unknown` run says unknown, a fallback-only
 * transport offers jump-to-terminal instead of implying structured events.
 */
import type { HarnessRunState } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/ui/lib/utils'
import { For, Show, type JSX } from 'solid-js'

import {
  deriveHarnessStatus,
  INSTALLATION_STATE_LABELS,
  installationDisplayState,
  isGlobalDefault,
  type InstallationDisplayState,
} from './harness-status-model'
import type { HarnessPreference, HarnessRun, ManagedPiStatus } from '@adea-ai/types/dev-runtime'

export function harnessStateDotClass(state: HarnessRunState | 'idle'): string {
  return cn('dev-status-dot', {
    'dev-status-dot--active': state === 'working',
    'dev-status-dot--ready': state === 'idle' || state === 'completed',
    'dev-status-dot--archived': state === 'cancelled',
  })
}

export function HarnessStatusPane(props: {
  runs: readonly HarnessRun[]
  preferences: readonly HarnessPreference[]
  managedPi?: Pick<ManagedPiStatus, 'state' | 'installationId' | 'executableLabel'>
  onJumpToTerminal?: () => void
  onResume?: (run: HarnessRun) => void
}) {
  const status = () => deriveHarnessStatus(props.runs)
  const globalDefault = () => props.preferences.find((preference) => isGlobalDefault(preference))
  const defaultLabel = (): string => {
    const preference = globalDefault()
    if (!preference) return props.managedPi?.executableLabel ?? 'No default set'
    if (props.managedPi?.installationId === preference.harnessInstallationId) {
      return props.managedPi.executableLabel ?? 'Managed Pi'
    }
    return 'Discovered harness'
  }

  const preferenceState = (preference: HarnessPreference): InstallationDisplayState =>
    installationDisplayState({
      preference,
      managedPi: props.managedPi,
      installationId: preference.harnessInstallationId,
    })

  const rows = (): JSX.Element => (
    <For each={props.preferences}>
      {(preference) => (
        <li class="dev-session-badge-row">
          <span>{preference.projectId === undefined ? 'Global' : 'Project'}</span>
          <span>{INSTALLATION_STATE_LABELS[preferenceState(preference)]}</span>
          <Show when={isGlobalDefault(preference)}>
            <span class="dev-row-badge dev-row-badge--success">default</span>
          </Show>
        </li>
      )}
    </For>
  )

  return (
    <section aria-label="Harness status" class="dev-session-badges">
      <p>
        <span role="img" class={harnessStateDotClass(status().state)} aria-hidden="true" />
        <span>{status().label}</span>
        <Show when={status().run}>
          {(run) => (
            <span class="dev-row-badge" title="Harness run generation">
              gen {run().generation}
            </span>
          )}
        </Show>
      </p>
      <p>Default harness: {defaultLabel()}</p>
      <Show when={status().terminalFallback}>
        <p>
          Structured transport unavailable; showing the terminal transcript projection.
          <Show when={props.onJumpToTerminal}>
            <button type="button" class="dev-button" onClick={() => props.onJumpToTerminal?.()}>
              Jump to terminal
            </button>
          </Show>
        </p>
      </Show>
      <Show
        when={
          status().run &&
          (status().run!.state === 'disconnected' ||
            status().run!.state === 'completed' ||
            status().run!.state === 'failed')
        }
      >
        <p>
          <button type="button" class="dev-button" onClick={() => props.onResume?.(status().run!)}>
            Resume as new generation
          </button>
        </p>
      </Show>
      <Show when={props.preferences.length > 0}>
        <ul aria-label="Harness preferences">{rows()}</ul>
      </Show>
    </section>
  )
}
