// The write side of the host detail: rename and revoke (#188). It is a separate module so a view
// that connects neither operation renders the panel without this code and shows both as
// unavailable with their reasons instead (the panel's `LeanHostActions`).
//
// The rename row itself lives in `self-hosted-rename-actions`, because this build mounts rename
// on its own: the mounted actions are a rename-only component, so pairing and revocation stay
// unavailable and cannot be switched on by handing the mounted component a revocation operation.
import type { ApiRuntimeNode } from '@adea-ai/api-client'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Alert, AlertDescription, AlertTitle } from '@adea-ai/ui/components/ui/alert'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@adea-ai/ui/components/ui/alert-dialog'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { createSignal, For, Show } from 'solid-js'

import {
  classifyFailure,
  hostIdentityLabel,
  revocationOutcome,
  revokeReasonProblem,
  REVOCATION_EFFECTS,
  type FailureGuidance,
} from './self-hosted-connection-model'
import type { Notice, SelfHostedOperations } from './self-hosted-connection-panel'
import { RenameHostActions } from './self-hosted-rename-actions'

export type HostActionsProps = Readonly<{
  node: ApiRuntimeNode
  hosts: readonly ApiRuntimeNode[]
  revoked: boolean
  operations: SelfHostedOperations
  /** Runs work for the scope that started it; a late result for another scope is dropped. */
  guarded: <T>(work: () => Promise<T>) => Promise<{ value: T } | { stale: true }>
  focusHeading: () => void
  refreshHosts: () => void | Promise<void>
  /** The host as the latest list read shows it, or undefined when it is no longer listed. */
  currentHost: (hostId: string) => ApiRuntimeNode | undefined
  notify: (notice: Notice) => void
  markUnconfirmed: (hostId: string, unconfirmed: boolean) => void
  onFailure: (failure: FailureGuidance, retry?: () => void) => void
  onRegisterAgain: () => void
}>

export function HostActions(props: HostActionsProps) {
  const [revokeOpen, setRevokeOpen] = createSignal(false)
  const [reasonDraft, setReasonDraft] = createSignal('')
  const [reasonProblem, setReasonProblem] = createSignal<string>()
  const [revokeBusy, setRevokeBusy] = createSignal(false)
  const [revokeFailure, setRevokeFailure] = createSignal<FailureGuidance>()
  let revokeTrigger: HTMLButtonElement | undefined
  let reasonInput: HTMLInputElement | undefined
  let revokeConfirm: HTMLButtonElement | undefined

  const revoke = async (reason: string) => {
    const hostId = props.node.id
    await props.operations.revokeHost!(hostId, reason)
    props.markUnconfirmed(hostId, true)
    // The list read decides what is true. Accepting the request is not the same.
    await props.refreshHosts()
    const outcome = revocationOutcome(true, props.currentHost(hostId), true)
    if (outcome === 'confirmed') {
      props.markUnconfirmed(hostId, false)
      props.notify({
        tone: 'success',
        title: `Execution revoked for ${props.node.displayName}`,
        text: 'Adea will send it no new commands. Nothing on the host was deleted and synchronized history access is unchanged.',
      })
    } else {
      props.notify({
        tone: 'warning',
        title: 'Revocation not confirmed yet',
        text:
          outcome === 'host_missing'
            ? 'Adea accepted the request, but the host is no longer in the list. Refresh to see the current state.'
            : 'Adea accepted the request, but the latest read still shows this host as registered. Refresh before relying on it either way.',
      })
    }
  }

  const beginRevoke = () => {
    setReasonProblem(undefined)
    setRevokeFailure(undefined)
    setRevokeOpen(true)
  }
  const submitRevoke = async () => {
    if (revokeBusy()) return
    const problem = revokeReasonProblem(reasonDraft())
    if (problem) {
      setReasonProblem(problem)
      reasonInput?.focus()
      return
    }
    setReasonProblem(undefined)
    setRevokeFailure(undefined)
    setRevokeBusy(true)
    try {
      const result = await props.guarded(() => revoke(reasonDraft().trim()))
      if ('stale' in result) return
      setRevokeOpen(false)
      setReasonDraft('')
      queueMicrotask(props.focusHeading)
    } catch (error) {
      const failure = classifyFailure(error, 'revoke')
      setRevokeFailure(failure)
      // A host that changed under us is stale state: close, refresh, and let the list speak.
      if (failure.kind === 'stale_state') {
        setRevokeOpen(false)
        props.onFailure(failure)
        queueMicrotask(props.focusHeading)
      } else queueMicrotask(() => revokeConfirm?.focus())
    } finally {
      setRevokeBusy(false)
    }
  }

  return (
    <>
      <RenameHostActions
        node={props.node}
        hosts={props.hosts}
        revoked={props.revoked}
        operations={props.operations}
        guarded={props.guarded}
        focusHeading={props.focusHeading}
        refreshHosts={props.refreshHosts}
        notify={props.notify}
        onFailure={props.onFailure}
      />
      <SettingsRow
        label={props.revoked ? 'Register again' : 'Revoke execution'}
        description={
          props.revoked
            ? 'This identity is revoked and cannot resume. Registering again creates a new identity.'
            : 'Stops Adea from sending this host new commands. It does not erase data or touch history access.'
        }
      >
        <Show
          when={!props.revoked}
          fallback={
            <Button type="button" variant="outline" onClick={props.onRegisterAgain}>
              Register again…
            </Button>
          }
        >
          <Button
            ref={(element) => (revokeTrigger = element)}
            type="button"
            variant="outline"
            disabled={!props.operations.revokeHost}
            aria-describedby="revoke-reason"
            onClick={beginRevoke}
          >
            Revoke execution…
          </Button>
        </Show>
      </SettingsRow>
      <Show when={!props.operations.revokeHost && !props.revoked}>
        <p id="revoke-reason" class="text-muted-foreground text-sm text-pretty">
          Not available yet: revoking is not connected in this build.
        </p>
      </Show>
      <AlertDialog
        open={revokeOpen()}
        onOpenChange={(open) => {
          if (!open && !revokeBusy()) {
            setRevokeOpen(false)
            queueMicrotask(() => revokeTrigger?.focus())
          }
        }}
      >
        <AlertDialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            reasonInput?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke execution for {props.node.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>{hostIdentityLabel(props.node)}</AlertDialogDescription>
          </AlertDialogHeader>
          <div class="flex flex-col gap-3 text-sm" data-testid="revoke-effects">
            <div>
              <p class="font-medium">This will</p>
              <ul class="text-muted-foreground list-disc ps-5">
                <For each={REVOCATION_EFFECTS.does}>{(item) => <li>{item}</li>}</For>
              </ul>
            </div>
            <div>
              <p class="font-medium">This will not</p>
              <ul class="text-muted-foreground list-disc ps-5">
                <For each={REVOCATION_EFFECTS.doesNot}>{(item) => <li>{item}</li>}</For>
              </ul>
            </div>
            <div class="flex flex-col gap-1">
              <Label for="revoke-reason-input">Reason</Label>
              <Input
                id="revoke-reason-input"
                ref={(element) => (reasonInput = element)}
                maxLength={400}
                autocomplete="off"
                aria-invalid={reasonProblem() ? true : undefined}
                aria-describedby={reasonProblem() ? 'revoke-reason-problem' : undefined}
                value={reasonDraft()}
                disabled={revokeBusy()}
                onInput={(event) => setReasonDraft(event.currentTarget.value)}
              />
              <Show when={reasonProblem()}>
                <p id="revoke-reason-problem" class="text-destructive" role="alert">
                  {reasonProblem()}
                </p>
              </Show>
            </div>
            <Show when={revokeFailure()}>
              {(failure) => (
                <Alert variant="destructive" role="alert" data-testid="revoke-failure">
                  <AlertTitle>{failure().title}</AlertTitle>
                  <AlertDescription>{failure().guidance}</AlertDescription>
                </Alert>
              )}
            </Show>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel as={Button} type="button" variant="outline" disabled={revokeBusy()}>
              Keep host
            </AlertDialogCancel>
            <Button
              ref={(element) => (revokeConfirm = element)}
              type="button"
              variant="destructive"
              aria-disabled={revokeBusy() || undefined}
              onClick={() => void submitRevoke()}
            >
              {revokeBusy() ? 'Revoking…' : 'Revoke execution'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
