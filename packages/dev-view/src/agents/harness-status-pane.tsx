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
  type HarnessDefaultSummary,
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
  /** True once the installed-harness read succeeded, so an empty list is real. */
  inventoryChecked?: boolean
  /** Reads that failed, shown beside a single retry; the rest of the pane stays usable. */
  readErrors?: readonly string[]
  onRetry?: () => void
  /** True while a rescan or a default change is in flight. */
  busy?: boolean
  /** The last typed failure of a rescan or default change. */
  actionError?: string
  /** Which rule decides a new session's harness, from the backend-confirmed rows. */
  defaultSummary?: HarnessDefaultSummary
  /** Device first: every workspace without its own default uses this one. */
  onMakeDeviceDefault?: (row: HarnessInventoryRow) => void
  /** The quieter per-workspace override. */
  onUseInWorkspace?: (row: HarnessInventoryRow) => void
  /** Drops this workspace's override so it follows the device default again. */
  onUseDeviceDefault?: () => void
  onRescan?: () => void
  onJumpToTerminal?: () => void
  onResume?: (run: HarnessRun) => void
}) {
  const status = () => deriveHarnessStatus(props.runs)
  const globalDefault = () => props.preferences.find((preference) => isGlobalDefault(preference))
  const defaultLabel = (): string => {
    const preference = globalDefault()
    if (props.defaultSummary) {
      if (props.defaultSummary.workspaceOverrideUnavailable && !props.defaultSummary.name) {
        return 'Not installed on this device'
      }
      return props.defaultSummary.name ?? 'No default set'
    }
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
      <p>
        Default harness: {defaultLabel()}
        <Show when={props.defaultSummary?.source === 'device'}>
          <span class="text-muted-foreground"> (device default)</span>
        </Show>
        <Show when={props.defaultSummary?.source === 'workspace'}>
          <span class="text-muted-foreground"> (this workspace)</span>
        </Show>
        <Show when={props.defaultSummary?.source === 'fallback'}>
          <span class="text-muted-foreground"> (until you choose a device default)</span>
        </Show>
      </p>
      <Show when={props.defaultSummary?.source === 'workspace' && props.onUseDeviceDefault}>
        <p class="flex flex-wrap items-center gap-2 text-xs">
          <span class="text-muted-foreground">
            <Show
              when={props.defaultSummary?.workspaceOverrideUnavailable}
              fallback={
                <Show
                  when={props.defaultSummary?.overriddenDeviceName}
                  fallback="This workspace has its own default."
                >
                  {(name) => <>This workspace overrides your device default ({name()}).</>}
                </Show>
              }
            >
              This workspace's own default is not installed and ready on this device, so new
              sessions here cannot start with it.
            </Show>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.busy}
            onClick={() => props.onUseDeviceDefault?.()}
          >
            Use device default
          </Button>
        </p>
      </Show>
      <Show when={props.defaultSummary?.deviceDefaultMissing}>
        <p role="status" class="text-xs">
          Your device default is not installed and ready on this device, so{' '}
          {props.defaultSummary?.source === 'workspace'
            ? 'workspaces without their own default'
            : 'new sessions'}{' '}
          cannot start with it. Rescan, or choose another harness.
        </p>
      </Show>
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
                    <Show when={row.isDeviceDefault}>
                      <Badge variant="secondary">Device default</Badge>
                    </Show>
                    <Show when={row.isWorkspaceDefault}>
                      <Badge variant="secondary">This workspace</Badge>
                    </Show>
                    <Show when={props.onMakeDeviceDefault && row.canMakeDeviceDefault}>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={props.busy}
                        aria-label={`Make ${row.name} the device default harness`}
                        onClick={() => props.onMakeDeviceDefault?.(row)}
                      >
                        Make device default
                      </Button>
                    </Show>
                    <Show when={props.onUseInWorkspace && row.canUseInWorkspace}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={props.busy}
                        aria-label={`Use ${row.name} for this workspace only`}
                        onClick={() => props.onUseInWorkspace?.(row)}
                      >
                        Use for this workspace
                      </Button>
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
      <Show
        when={
          props.inventoryChecked &&
          (props.inventoryRows?.length ?? 0) === 0 &&
          (props.readErrors?.length ?? 0) === 0
        }
      >
        <p role="status" class="text-muted-foreground text-xs">
          No harnesses found on this device yet. Rescan to look for installed harnesses.
        </p>
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
      <Show when={(props.readErrors?.length ?? 0) > 0}>
        <div role="alert" class="text-destructive flex flex-col gap-1 text-xs">
          <For each={props.readErrors}>{(message) => <p>{message}</p>}</For>
          <Show when={props.onRetry}>
            <p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={props.busy}
                onClick={() => props.onRetry?.()}
              >
                Try again
              </Button>
            </p>
          </Show>
        </div>
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
