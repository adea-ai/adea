// Setup guidance for connecting a Control Plane you run yourself (#188). The pairing values are
// secret and live in this component's memory only: they are never written to storage, cleared
// when they expire, are used, or the account or workspace changes, and shown once.
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Alert, AlertDescription, AlertTitle } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'

import {
  classifyFailure,
  pairingRemaining,
  hostsRegisteredSince,
  pairingState,
  sameScope,
  type PairingGrant,
  type PairingScope,
  type PairingState,
} from './self-hosted-connection-model'
import { SelfHostedSetupGuideShell } from './self-hosted-setup-guide-shell'

type ActivePairing = Readonly<{
  grant: PairingGrant | undefined
  hostIdsAtIssue: readonly string[]
  issuedAt: number
  scope: PairingScope
  /** Non-secret record of the pairing, kept after the secrets are cleared. */
  challengeId: string
  expiresAt: string
}>

const STATE_COPY: Readonly<Record<PairingState, { label: string; detail: string }>> = {
  active: {
    label: 'Waiting for the host',
    detail:
      'The values are shown until the deadline passes or you clear them. Adea cannot see whether a host has already used them.',
  },
  expired: {
    label: 'Expired',
    detail:
      'The deadline passed. The values were cleared; create a new pairing. Expiry shows only that time ran out: Adea cannot tell whether a host used the pairing first, so check the list.',
  },
  discarded: {
    label: 'Discarded',
    detail:
      'You switched account or workspace, so the values created for the previous one were cleared. A pairing only works where it was created.',
  },
}

export type SetupGuideProps = Readonly<{
  scope: PairingScope
  now: () => number
  /** Registered host ids right now. A new id after a pairing was issued means it was used. */
  hostIds: readonly string[]
  /** Undefined means creating a pairing is not connected in this build. */
  openPairing: (() => Promise<PairingGrant>) | undefined
  onRefreshHosts: () => void | Promise<void>
  onClose: () => void
  /** Registering again after a revoke starts a new identity; the copy says so. */
  reregistering?: boolean
}>

export function SelfHostedSetupGuide(props: SetupGuideProps) {
  const [pairing, setPairing] = createSignal<ActivePairing>()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<ReturnType<typeof classifyFailure>>()
  const [revealed, setRevealed] = createSignal(false)
  const [copied, setCopied] = createSignal<string>()
  let generation = 0
  let valuesHeading: HTMLHeadingElement | undefined
  let createButton: HTMLButtonElement | undefined
  onCleanup(() => {
    generation += 1
  })

  const state = (): PairingState | undefined => {
    const current = pairing()
    return current
      ? pairingState(
          { expiresAt: current.expiresAt, issuedAt: current.issuedAt, scope: current.scope },
          { hostIds: props.hostIds, hostIdsAtIssue: current.hostIdsAtIssue, scope: props.scope },
          props.now()
        )
      : undefined
  }

  // Secrets are dropped the moment the pairing stops being usable.
  createEffect(() => {
    const current = pairing()
    if (current?.grant && state() !== 'active') {
      setPairing({ ...current, grant: undefined })
      setRevealed(false)
    }
  })

  const create = async () => {
    if (!props.openPairing || busy()) return
    const scopeAtStart = props.scope
    const mine = ++generation
    setBusy(true)
    setFailure(undefined)
    try {
      const grant = await props.openPairing()
      if (mine !== generation || !sameScope(scopeAtStart, props.scope)) return
      setPairing({
        challengeId: grant.challengeId,
        expiresAt: grant.expiresAt,
        grant,
        hostIdsAtIssue: [...props.hostIds],
        issuedAt: props.now(),
        scope: scopeAtStart,
      })
      setRevealed(false)
      setCopied(undefined)
      queueMicrotask(() => valuesHeading?.focus())
    } catch (error) {
      if (mine !== generation || !sameScope(scopeAtStart, props.scope)) return
      setFailure(classifyFailure(error, 'pairing'))
      queueMicrotask(() => createButton?.focus())
    } finally {
      if (mine === generation) setBusy(false)
    }
  }

  const discard = () => {
    setPairing(undefined)
    setRevealed(false)
    setCopied(undefined)
    queueMicrotask(() => createButton?.focus())
  }

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
    } catch {
      setCopied(`${label}:failed`)
    }
  }

  const step2 = (
    <>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          ref={(element) => (createButton = element)}
          type="button"
          disabled={!props.openPairing}
          aria-disabled={busy() || undefined}
          aria-describedby={props.openPairing ? undefined : 'pairing-unavailable'}
          onClick={() => void create()}
        >
          {busy() ? 'Creating…' : pairing() ? 'Create a new pairing' : 'Create pairing'}
        </Button>
        <Show when={pairing()}>
          <Button type="button" variant="ghost" onClick={discard}>
            Clear these values
          </Button>
        </Show>
      </div>
      <Show when={!props.openPairing}>
        <p id="pairing-unavailable" class="text-muted-foreground text-sm">
          Not available yet: creating a pairing is not connected in this build, so nothing can be
          registered from here.
        </p>
      </Show>
      <Show when={failure()}>
        {(current) => (
          <Alert variant="destructive" role="alert" data-testid="pairing-failure">
            <AlertTitle>{current().title}</AlertTitle>
            <AlertDescription>{current().guidance}</AlertDescription>
          </Alert>
        )}
      </Show>
      <Show when={pairing()}>
        {(current) => (
          <PairingValues
            busy={busy()}
            copied={copied()}
            current={current()}
            now={props.now}
            revealed={revealed()}
            state={state() ?? 'discarded'}
            newHostCount={hostsRegisteredSince(props.hostIds, current().hostIdsAtIssue).length}
            onCopy={copy}
            onReveal={() => setRevealed(!revealed())}
            setHeading={(element) => (valuesHeading = element)}
            workspaceId={props.scope.workspaceId}
          />
        )}
      </Show>
    </>
  )

  return (
    <SelfHostedSetupGuideShell
      onClose={props.onClose}
      onRefreshHosts={props.onRefreshHosts}
      reregistering={props.reregistering}
      step2={step2}
    />
  )
}

function PairingValues(props: {
  busy: boolean
  copied: string | undefined
  current: ActivePairing
  now: () => number
  revealed: boolean
  state: PairingState
  /** Hosts that registered since issue. Not attributable to this pairing. */
  newHostCount: number
  onCopy: (label: string, value: string) => void | Promise<void>
  onReveal: () => void
  setHeading: (element: HTMLHeadingElement) => void
  workspaceId: string
}) {
  const grant = () => props.current.grant
  const copy = () => STATE_COPY[props.state]
  const rows = (): readonly (readonly [string, string, boolean])[] => {
    const value = grant()
    if (!value) return []
    return [
      ['Workspace ID', props.workspaceId, false],
      ['Pairing ID', value.challengeId, false],
      ['Nonce', value.nonce, false],
      ['Registration credential', value.exchangeCredential, true],
    ]
  }
  return (
    <div
      class="border-border bg-card flex flex-col gap-3 rounded-lg border p-4"
      data-testid="pairing-values"
      data-pairing-state={props.state}
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3
          ref={props.setHeading}
          tabindex="-1"
          class="text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Pairing values
        </h3>
        <StatusChip
          tone={props.state === 'active' ? 'info' : 'unknown'}
          label={copy().label}
          trailing={
            props.state === 'active' ? (
              <span class="text-muted-foreground font-normal">
                {pairingRemaining(props.current.expiresAt, props.now())}
              </span>
            ) : undefined
          }
        />
      </div>
      <p class="text-muted-foreground text-sm text-pretty" role="status">
        {copy().detail}
      </p>
      <Show when={props.state === 'active' && props.newHostCount > 0}>
        <p class="text-muted-foreground text-sm text-pretty" data-testid="pairing-new-host-note">
          {props.newHostCount === 1 ? 'A host' : `${props.newHostCount} hosts`} registered since
          this pairing was created. Adea cannot tell which pairing{' '}
          {props.newHostCount === 1 ? 'it' : 'they'} used, so these values are still shown and may
          already have been used. Check the list to see whether your host appeared.
        </p>
      </Show>
      <Show when={grant()}>
        <div class="flex flex-col">
          <For each={rows()}>
            {([label, value, secret]) => (
              <SettingsRow label={label} orientation="vertical">
                <div class="flex w-full items-center gap-2">
                  <Input
                    readOnly
                    aria-label={label}
                    type={secret && !props.revealed ? 'password' : 'text'}
                    value={value}
                    spellcheck={false}
                    autocomplete="off"
                  />
                  <Show when={secret}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-pressed={props.revealed}
                      aria-label={`${props.revealed ? 'Hide' : 'Show'} registration credential`}
                      onClick={props.onReveal}
                    >
                      {props.revealed ? 'Hide' : 'Show'}
                    </Button>
                  </Show>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Copy ${label}`}
                    onClick={() => void props.onCopy(label, value)}
                  >
                    Copy
                  </Button>
                </div>
              </SettingsRow>
            )}
          </For>
        </div>
        <p class="text-muted-foreground text-xs" role="status" data-testid="copy-status">
          <Show when={props.copied}>
            {(label) =>
              label().endsWith(':failed')
                ? 'Copying was blocked. Select the value and copy it yourself.'
                : `${label()} copied.`
            }
          </Show>
        </p>
        <p class="text-muted-foreground text-xs">
          Expiry follows this device’s clock. Adea keeps only a digest of the credential and cannot
          show it again.
        </p>
      </Show>
      <Show when={!grant()}>
        <p class="text-muted-foreground text-xs">
          Pairing {props.current.challengeId.slice(0, 8)}… · values cleared.
        </p>
      </Show>
    </div>
  )
}
