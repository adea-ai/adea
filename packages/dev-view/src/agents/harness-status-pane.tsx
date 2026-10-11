/*
 * Agents pane status surface (#400): the session's harness status rendered
 * from the pure model. All state distinctions come from canonical run facts
 * (HarnessRun/AcpConnection through the gate); the pane owns no authority and
 * never fabricates a state — an `unknown` run says unknown, a fallback-only
 * transport offers jump-to-terminal instead of implying structured events.
 */
import { For, Show, type JSX } from 'solid-js'

import {
  deriveHarnessStatus,
  INSTALLATION_STATE_LABELS,
  installationDisplayState,
  isGlobalDefault,
  type InstallationDisplayState,
  type HarnessStatusTone,
} from './harness-status-model'
import type { HarnessPreference, HarnessRun, ManagedPiStatus } from '@adea-ai/types/dev-runtime'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { StatusChip, type StatusTone } from '@adea-ai/ui/components/ui/status-chip'
import { ListRowControl } from '@adea-ai/ui/components/composites/list-row'

const SHARED_STATUS_TONES: Record<HarnessStatusTone, StatusTone> = {
  neutral: 'neutral',
  progress: 'info',
  success: 'success',
  failure: 'danger',
  unknown: 'unknown',
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
        <ListRowControl
          as="li"
          description={INSTALLATION_STATE_LABELS[preferenceState(preference)]}
          trailing={
            <Show when={isGlobalDefault(preference)}>
              <Badge variant="secondary">default</Badge>
            </Show>
          }
        >
          {preference.projectId === undefined ? 'Global' : 'Project'}
        </ListRowControl>
      )}
    </For>
  )

  return (
    <section aria-label="Harness status">
      <p class="flex flex-wrap items-center gap-2">
        <StatusChip label={status().label} tone={SHARED_STATUS_TONES[status().tone]} />
        <Show when={status().run}>
          {(run) => (
            <Badge variant="outline" title="Harness run generation">
              gen {run().generation}
            </Badge>
          )}
        </Show>
        <Show when={status().run?.terminalId}>
          {(terminalId) => (
            <Badge
              variant="outline"
              title={`Harness process runs in terminal ${terminalId()} (attachTerminal launch)`}
            >
              in terminal
            </Badge>
          )}
        </Show>
      </p>
      <p>Default harness: {defaultLabel()}</p>
      <Show when={status().terminalFallback}>
        <p>
          Structured transport unavailable; showing the terminal transcript projection.
          <Show when={props.onJumpToTerminal}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => props.onJumpToTerminal?.()}
            >
              Jump to terminal
            </Button>
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => props.onResume?.(status().run!)}
          >
            Resume as new generation
          </Button>
        </p>
      </Show>
      <Show when={props.preferences.length > 0}>
        <ul aria-label="Harness preferences" class="flex flex-col gap-1">
          {rows()}
        </ul>
      </Show>
    </section>
  )
}
