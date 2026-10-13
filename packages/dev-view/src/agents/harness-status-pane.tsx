/*
 * Agents pane status surface (#400): the session's harness status rendered
 * from the pure model. All state distinctions come from canonical run facts
 * (HarnessRun/AcpConnection through the gate); the pane owns no authority and
 * never fabricates a state — an `unknown` run says unknown, a fallback-only
 * transport offers jump-to-terminal instead of implying structured events.
 */
import { For, Show, type JSX } from 'solid-js'

import {
  capabilityLabel,
  deriveHarnessStatus,
  INSTALLATION_STATE_LABELS,
  installationDisplayState,
  isGlobalDefault,
  type HarnessInventoryRow,
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
  /** The backend-confirmed installations (`dev.harness.inventory`). */
  inventoryRows?: readonly HarnessInventoryRow[]
  /** True while a rescan or a default change is in flight. */
  busy?: boolean
  /** The last typed failure of a rescan or default change. */
  actionError?: string
  onMakeDefault?: (installationId: string) => void
  onRescan?: () => void
  onJumpToTerminal?: () => void
  onResume?: (run: HarnessRun) => void
}) {
  const status = () => deriveHarnessStatus(props.runs)
  const globalDefault = () => props.preferences.find((preference) => isGlobalDefault(preference))
  const defaultLabel = (): string => {
    const preference = globalDefault()
    const named = props.inventoryRows?.find((row) => row.isDefault)
    if (named) return named.name
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
    <section aria-label="Harness status" class="dev-harness-status">
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
      <Show
        when={(props.inventoryRows?.length ?? 0) > 0}
        fallback={
          <Show when={props.preferences.length > 0}>
            <ul aria-label="Harness preferences" class="flex flex-col gap-1">
              {rows()}
            </ul>
          </Show>
        }
      >
        <ul aria-label="Installed harnesses" class="flex flex-col gap-1">
          <For each={props.inventoryRows}>
            {(row) => (
              <ListRowControl
                as="li"
                description={[
                  row.version ? `v${row.version}` : undefined,
                  row.stale ? `${row.stateLabel} (last scan is stale)` : row.stateLabel,
                  ...row.blockers,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                trailing={
                  <span class="flex flex-wrap items-center justify-end gap-1">
                    <For each={row.capabilities}>
                      {(capability) => (
                        <Badge variant="outline">{capabilityLabel(capability)}</Badge>
                      )}
                    </For>
                    <Show
                      when={row.isDefault}
                      fallback={
                        <Show when={props.onMakeDefault && row.canMakeDefault}>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={props.busy}
                            aria-label={`Make ${row.name} the default harness`}
                            onClick={() => props.onMakeDefault?.(row.installationId)}
                          >
                            Make default
                          </Button>
                        </Show>
                      }
                    >
                      <Badge variant="secondary">default</Badge>
                    </Show>
                  </span>
                }
              >
                {row.name}
              </ListRowControl>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.onRescan}>
        <p class="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.busy}
            onClick={() => props.onRescan?.()}
          >
            Rescan this device
          </Button>
          <span class="text-muted-foreground text-xs">
            Detected on this device only; a harness installed elsewhere is not listed.
          </span>
        </p>
      </Show>
      <Show when={props.actionError}>
        {(message) => (
          <p role="alert" class="text-destructive text-xs">
            {message()}
          </p>
        )}
      </Show>
    </section>
  )
}
