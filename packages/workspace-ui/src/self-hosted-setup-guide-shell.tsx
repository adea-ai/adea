// The setup guide's structure and copy (#188): the four steps, the host-side note and the refusal
// reference. The one step that holds secrets (creating a pairing and showing its values) is a slot,
// so a view that cannot create pairings renders the same guide without that code.
import { SettingsSection } from '@adea-ai/ui/components/composites/settings'
import { Alert, AlertDescription, AlertTitle } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { For, type JSX } from 'solid-js'

import { classifyFailure } from './self-hosted-connection-model'

/** Refusals a host can report when it registers, in the words this surface uses for them. */
const HOST_REFUSALS = [
  ['challenge_expired', 'The host says the challenge expired'],
  ['challenge_used', 'The host says the challenge was already used'],
  ['exchange_credential_invalid', 'The host says the registration credential was invalid'],
  ['unauthorized', 'The host says it is not authorized'],
  ['key_mismatch', 'The host says its keys do not match'],
  ['revoked', 'The host says its identity was revoked'],
] as const

export function SelfHostedSetupGuideShell(
  props: Readonly<{
    onClose: () => void
    onRefreshHosts: () => void | Promise<void>
    /** Registering again after a revoke starts a new identity; the copy says so. */
    reregistering?: boolean
    /** Everything under step 2's introduction: the create control and the pairing values. */
    step2: JSX.Element
  }>
) {
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
          {props.step2}
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

/** Step 2 when creating a pairing is not connected: the control is present, disabled, and says why. */
export function PairingUnavailable() {
  return (
    <>
      <div class="flex flex-wrap items-center gap-2">
        <Button type="button" disabled aria-describedby="pairing-unavailable">
          Create pairing
        </Button>
      </div>
      <p id="pairing-unavailable" class="text-muted-foreground text-sm">
        Not available yet: creating a pairing is not connected in this build, so nothing can be
        registered from here.
      </p>
    </>
  )
}
