/*
 * Confirmation for stopping or restarting a process (spec "Machine-wide
 * inventory and foreign stop", TM-018). The dialog asks the host for a plan
 * first and shows exactly what it names: for a process Adea did not start,
 * the command, folder, PID, owner, and every PID the host will signal, plus
 * the explicit force option (re-planned when toggled). Confirmation is per
 * process; nothing here can confirm in bulk or remember a choice.
 */
import type { DevError, ForeignStopResult, MutationPlan } from '@adea-ai/types/dev-runtime'
import { createEffect, createSignal, For, on, Show } from 'solid-js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@adea-ai/ui/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Checkbox } from '@adea-ai/ui/components/ui/checkbox'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

import { startedLabel, type ServerRow } from './resources-view-model'

export type StopIntent = Readonly<{ mode: 'stop' | 'restart'; row: ServerRow }>

export type ResourceCommandRunner = <T>(
  operation:
    | 'dev.resources.stopPlan'
    | 'dev.resources.stopCommit'
    | 'dev.resources.restartPlan'
    | 'dev.resources.restartCommit'
    | 'dev.resources.foreignStopPlan'
    | 'dev.resources.foreignStopCommit',
  body: Record<string, unknown>,
  resource: { kind: string; id: string; generation: number }
) => Promise<T>

export function commandError(error: unknown): DevError {
  return (
    (error as { error?: DevError })?.error ?? {
      code: 'invalid_state',
      retryable: false,
      message: error instanceof Error ? error.message : 'command failed',
    }
  )
}

const OUTCOME_TEXT: Record<ForeignStopResult['outcome'], string> = {
  stopped: 'Stopped.',
  forced: 'Force stopped.',
  already_gone: 'It had already exited.',
  still_running: 'It is still running. Try again with force stop.',
}

export function StopDialog(props: {
  intent: StopIntent | undefined
  run: ResourceCommandRunner
  onClose(): void
  onDone(message: string): void
}) {
  const [plan, setPlan] = createSignal<MutationPlan>()
  const [force, setForce] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<DevError>()

  const row = () => props.intent?.row
  const foreign = () => {
    const current = row()
    return current?.kind === 'foreign' ? current : undefined
  }
  const owned = () => {
    const current = row()
    return current?.kind === 'owned' ? current : undefined
  }

  async function requestPlan(): Promise<void> {
    const intent = props.intent
    if (!intent) return
    setPlan(undefined)
    setError(undefined)
    setBusy(true)
    try {
      if (intent.row.kind === 'foreign') {
        const record = intent.row.record
        setPlan(
          await props.run<MutationPlan>(
            'dev.resources.foreignStopPlan',
            {
              foreignProcessId: record.id,
              expectedGeneration: record.observationGeneration,
              force: force(),
              reason: `Stop ${record.label} (PID ${record.pid})`,
            },
            { kind: 'foreign_process', id: record.id, generation: record.observationGeneration }
          )
        )
      } else if (intent.mode === 'restart') {
        const record = intent.row.record
        setPlan(
          await props.run<MutationPlan>(
            'dev.resources.restartPlan',
            {
              processRecordId: record.id,
              expectedGeneration: record.generation,
              reason: `Restart ${record.ownerKind} ${record.ownerId}`,
            },
            { kind: 'process', id: record.id, generation: record.generation }
          )
        )
      } else {
        const record = intent.row.record
        setPlan(
          await props.run<MutationPlan>(
            'dev.resources.stopPlan',
            {
              processRecordId: record.id,
              expectedGeneration: record.generation,
              reason: `Stop ${record.ownerKind} ${record.ownerId}`,
            },
            { kind: 'process', id: record.id, generation: record.generation }
          )
        )
      }
    } catch (failure) {
      setError(commandError(failure))
    } finally {
      setBusy(false)
    }
  }

  createEffect(
    on(
      () => props.intent,
      (intent) => {
        setForce(false)
        if (intent) void requestPlan()
      }
    )
  )

  async function confirm(): Promise<void> {
    const intent = props.intent
    const current = plan()
    if (!intent || !current) return
    setBusy(true)
    setError(undefined)
    try {
      const body = { planId: current.id, planDigest: current.digest }
      if (intent.row.kind === 'foreign') {
        const result = await props.run<ForeignStopResult>('dev.resources.foreignStopCommit', body, {
          kind: 'foreign_process',
          id: current.resource.id,
          generation: current.resource.generation,
        })
        props.onDone(`${intent.row.title}: ${OUTCOME_TEXT[result.outcome]}`)
      } else if (intent.mode === 'restart') {
        await props.run('dev.resources.restartCommit', body, {
          kind: 'process',
          id: current.resource.id,
          generation: current.resource.generation,
        })
        props.onDone(`${intent.row.title} restarted.`)
      } else {
        await props.run('dev.resources.stopCommit', body, {
          kind: 'process',
          id: current.resource.id,
          generation: current.resource.generation,
        })
        props.onDone(`${intent.row.title} stopped.`)
      }
    } catch (failure) {
      setError(commandError(failure))
    } finally {
      setBusy(false)
    }
  }

  const title = () => {
    const intent = props.intent
    if (!intent) return ''
    const port = intent.row.ports.length > 0 ? ` on port ${portText(intent.row)}` : ''
    return intent.mode === 'restart'
      ? `Restart ${intent.row.title}${port}?`
      : `Stop ${intent.row.title}${port}?`
  }

  return (
    <AlertDialog
      open={props.intent !== undefined}
      onOpenChange={(open) => {
        if (!open && !busy()) props.onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title()}</AlertDialogTitle>
          <AlertDialogDescription>
            <Show
              when={foreign()}
              fallback={
                props.intent?.mode === 'restart'
                  ? 'Adea stops this process and starts it again from the same command.'
                  : 'Adea stops this process gracefully. It started it, and checks it is still the same process first.'
              }
            >
              {(current) => (
                <>
                  Adea didn’t start this
                  {current().attributionLabel
                    ? ` — it was started by ${current().attributionLabel}`
                    : ''}
                  . Unsaved work in it will be lost.
                </>
              )}
            </Show>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Show when={foreign()}>
          {(current) => (
            <dl class="dev-resources__facts">
              <Show when={current().record.commandPreview}>
                <dt>Command</dt>
                <dd class="dev-resources__code">{current().record.commandPreview}</dd>
              </Show>
              <Show when={current().record.cwdLabel}>
                <dt>Folder</dt>
                <dd class="dev-resources__code">{current().record.cwdLabel}</dd>
              </Show>
              <dt>Owner</dt>
              <dd>{current().attributionLabel ?? 'Unknown'} · not started by Adea</dd>
              <dt>Process</dt>
              <dd>
                PID {current().record.pid} · {current().record.childCount} child{' '}
                {current().record.childCount === 1 ? 'process' : 'processes'}
              </dd>
              <dt>Started</dt>
              <dd>{startedLabel(current().record.startIdentity, Date.now())}</dd>
            </dl>
          )}
        </Show>
        <Show when={owned()}>
          {(current) => (
            <dl class="dev-resources__facts">
              <dt>Owner</dt>
              <dd>
                {current().title}
                {current().sessionLabel ? ` · ${current().sessionLabel}` : ''}
              </dd>
              <dt>Process</dt>
              <dd>
                {current().command} · PID {current().record.pid} · generation{' '}
                {current().record.generation}
              </dd>
              <dt>Started</dt>
              <dd>{startedLabel(current().record.startIdentity, Date.now())}</dd>
            </dl>
          )}
        </Show>

        <Show when={plan()}>
          {(current) => (
            <p class="dev-resources__note">
              <Show
                when={foreign()}
                fallback={`Plan ready: ${current().steps.length} ${current().steps.length === 1 ? 'step' : 'steps'}.`}
              >
                Adea will send a graceful stop to{' '}
                <For each={current().steps}>
                  {(step, index) => (
                    <>
                      {index() > 0 ? ', ' : ''}
                      <span class="dev-resources__code">{step.targetId}</span>
                    </>
                  )}
                </For>
                , children first, after checking each one is still the same process.
              </Show>
            </p>
          )}
        </Show>

        <Show when={foreign()}>
          <Checkbox
            checked={force()}
            disabled={busy()}
            onChange={(value: boolean) => {
              setForce(value)
              void requestPlan()
            }}
            label="Force stop if it is still running after 10 seconds"
            description="Off by default. Forcing skips the process’s own clean shutdown."
          />
        </Show>

        <Show when={error()}>
          {(failure) => (
            <Alert variant="destructive">
              <AlertDescription>
                {failure().message} <span class="dev-resources__code">({failure().code})</span>
              </AlertDescription>
            </Alert>
          )}
        </Show>

        <AlertDialogFooter>
          <AlertDialogCancel as={Button} type="button" variant="outline" disabled={busy()}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            as={ActionButton}
            type="button"
            variant="destructive"
            busy={busy()}
            busyLabel={props.intent?.mode === 'restart' ? 'Restarting' : 'Stopping'}
            disabled={plan() === undefined || busy()}
            closeOnClick={false}
            onClick={(event: MouseEvent) => {
              event.preventDefault()
              void confirm()
            }}
          >
            {props.intent?.mode === 'restart' ? 'Restart process' : 'Stop process'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function portText(row: ServerRow): string {
  if (row.kind === 'owned') return row.ports.map((port) => port.port).join(', ')
  return row.ports.join(', ')
}
