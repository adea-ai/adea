// Setup guidance for connecting a Control Plane you run yourself (#188). The pairing values are
// secret and live in this component's memory only: they are never written to storage, cleared
// when they expire, are used, or the account or workspace changes, and shown once.
import { SettingsRow, SettingsSection } from '@adea-ai/ui/components/composites/settings'
import { Alert, AlertDescription, AlertTitle } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'

import {
  classifyFailure,
  pairingRemaining,
  pairingState,
  sameScope,
  type PairingGrant,
  type PairingScope,
  type PairingState,
} from './self-hosted-connection-model'

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
    detail: 'The pairing works for one registration until it expires.',
  },
  expired: {
    label: 'Expired',
    detail: 'The pairing ran out before a host used it. The values were cleared; create a new one.',
  },
  consumed: {
    label: 'Used',
    detail:
      'A host registered after this pairing was created, so its one-time values were used and cleared. If that was not your host, revoke it from the list.',
  },
  discarded: {
    label: 'Discarded',
    detail:
      'You switched account or workspace, so the values created for the previous one were cleared. A pairing only works where it was created.',
  },
}

/** Refusals a host can report when it registers, in the words this surface uses for them. */
const HOST_REFUSALS = [
  ['challenge_expired', 'The host says the challenge expired'],
  ['challenge_used', 'The host says the challenge was already used'],
  ['exchange_credential_invalid', 'The host says the registration credential was invalid'],
  ['unauthorized', 'The host says it is not authorized'],
  ['key_mismatch', 'The host says its keys do not match'],
  ['revoked', 'The host says its identity was revoked'],
] as const

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

  return (
    <SettingsSection
      title={props.reregistering ? 'Register this host again' : 'Connect a self-hosted host'}
      description={
        props.reregistering
          ? 'A revoked identity cannot resume. Registering again creates a new, separate identity.'
          : 'Run the Control Plane on a server you control, then register it with a one-time pairing. Adea does not create, host or access that server.'
      }
      bodyLayout="content"
      action={
        <Button type="button" variant="ghost" size="sm" onClick={props.onClose}>
          Close setup
        </Button>
      }
      aria-label="Connect a self-hosted host"
    >
      <ol class="flex flex-col gap-4 text-sm" data-testid="setup-steps">
        <li class="flex flex-col gap-1">
          <p class="font-medium">1. Prepare the host</p>
          <ul class="text-muted-foreground flex list-disc flex-col gap-1 ps-5 text-pretty">
            <li>
              Deploy the Control Plane reference stack with Docker Compose on a Linux server you
              control.
            </li>
            <li>
              Keep its API on the server’s loopback address and do not publish the port. Adea
              reaches the host through the host’s own outbound registration, not an open admin
              endpoint.
            </li>
            <li>
              Keep provider keys, database passwords and the host’s data on the host. Adea never
              asks for them.
            </li>
          </ul>
        </li>
        <li class="flex flex-col gap-2">
          <p class="font-medium">2. Create a one-time pairing</p>
          <p class="text-muted-foreground text-pretty">
            A pairing lasts ten minutes and registers one host. The registration credential is shown
            only here and only once. Treat it like a password.
          </p>
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
              Not available yet: creating a pairing is not connected in this build, so nothing can
              be registered from here.
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
                onCopy={copy}
                onReveal={() => setRevealed(!revealed())}
                setHeading={(element) => (valuesHeading = element)}
                workspaceId={props.scope.workspaceId}
              />
            )}
          </Show>
        </li>
        <li class="flex flex-col gap-2">
          <p class="font-medium">3. Register the host</p>
          <p class="text-muted-foreground text-pretty">
            Give the four values to the host’s registration. The host signs the pairing with its own
            key, so Adea receives only a public key and never a reusable server credential.
          </p>
          <Alert role="note" data-testid="host-step-unavailable">
            <AlertTitle>Host-side step not available yet</AlertTitle>
            <AlertDescription>
              The reference stack does not include a registration command, so this step cannot be
              completed from the product today. The values above are what that command will take.
            </AlertDescription>
          </Alert>
        </li>
        <li class="flex flex-col gap-2">
          <p class="font-medium">4. Check the connection</p>
          <p class="text-muted-foreground text-pretty">
            A registered host appears in the list. Select it and run a check. Registered does not
            mean running, compatible or allowed to take work; the check shows each of those
            separately.
          </p>
          <div>
            <Button type="button" variant="outline" onClick={() => void props.onRefreshHosts()}>
              Refresh hosts
            </Button>
          </div>
        </li>
      </ol>
      <details class="text-sm" data-testid="refusal-reference">
        <summary class="cursor-pointer font-medium">If the host reports a refusal</summary>
        <dl class="mt-3 flex flex-col gap-3">
          <For each={HOST_REFUSALS}>
            {([code, heading]) => {
              const guidance = classifyFailure({ code, status: 409 }, 'pairing')
              return (
                <div>
                  <dt class="font-medium">{heading}</dt>
                  <dd class="text-muted-foreground text-pretty">{guidance.guidance}</dd>
                </div>
              )
            }}
          </For>
        </dl>
      </details>
    </SettingsSection>
  )
}

function PairingValues(props: {
  busy: boolean
  copied: string | undefined
  current: ActivePairing
  now: () => number
  revealed: boolean
  state: PairingState
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
