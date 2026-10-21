// Self-hosted hosts: list, explicit selection, diagnostics, reconnect, rename and revoke (#188).
//
// Controlled and presentational. Data arrives as observations (`hosts`, `discoveryFor`) and every
// effect is an optional operation. A missing operation renders as unavailable with its reason,
// never as a working control. Execution-host registration and synchronized-history authority are
// shown as two separate things, and an unknown fact is shown as unknown.
import type { ApiRuntimeNode } from '@adea-ai/api-client'
import { SettingsRow, SettingsSection } from '@adea-ai/ui/components/composites/settings'
import { Alert, AlertDescription, AlertTitle } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Component,
} from 'solid-js'
import { Dynamic } from 'solid-js/web'

import { keyedRows } from './keyed-rows'
import {
  classifyFailure,
  diagnoseHost,
  executionAuthority,
  historyAuthority,
  hostHeadline,
  hostIdentityLabel,
  hostSelectability,
  remediationSteps,
  sameScope,
  type AuthorityPanel,
  type DiscoveryRead,
  type FailureGuidance,
  type HostInput,
  type PairingGrant,
  type PairingScope,
} from './self-hosted-connection-model'
import type { HostActionsProps } from './self-hosted-host-actions'
import { PairingUnavailable, SelfHostedSetupGuideShell } from './self-hosted-setup-guide-shell'
import type { SetupGuideProps } from './self-hosted-setup-guide'

/** Effects. An undefined operation is not connected, and its control says so. */
export type SelfHostedOperations = Readonly<{
  openPairing?: () => Promise<PairingGrant>
  renameHost?: (hostId: string, displayName: string) => Promise<void>
  revokeHost?: (hostId: string, reason: string) => Promise<void>
}>

export type HostsRead =
  | Readonly<{ state: 'loading' }>
  | Readonly<{ state: 'failed'; status?: number }>
  | Readonly<{
      state: 'ready'
      nodes: readonly ApiRuntimeNode[]
      /** A refresh is in flight; the previous list stays visible and its ages keep counting. */
      refreshing?: boolean
      /** The last refresh failed; the list shown is the last one that was read. */
      refreshFailed?: Readonly<{ status?: number }>
    }>

export type SelfHostedPanelProps = Readonly<{
  scope: PairingScope
  now: () => number
  hosts: HostsRead
  /** What the last discovery read for a host produced. */
  discoveryFor: (hostId: string) => DiscoveryRead
  inspectedId: string | undefined
  onInspect: (hostId: string | undefined) => void
  /** Resolves when the refreshed list has settled. */
  onRefreshHosts: () => void | Promise<void>
  /** Re-reads one host; resolves when the read has settled. */
  onCheckHost: (hostId: string) => void | Promise<void>
  operations: SelfHostedOperations
  /** The host chosen for new work. The caller owns where this is stored. */
  chosenHostId?: string
  /** Undefined means choosing a host is not connected in this build. */
  onChooseHost?: (hostId: string | undefined) => void
  requiredCapabilities?: readonly string[]
  /**
   * The code behind the operations. Without a slot the panel renders the same controls disabled,
   * each with the reason it is unavailable, and carries none of the code that would run them.
   */
  slots?: PanelSlots
}>

export type PanelSlots = Readonly<{
  HostActions?: Component<HostActionsProps>
  SetupGuide?: Component<SetupGuideProps>
}>

export type Notice = Readonly<{
  tone: 'danger' | 'success' | 'warning'
  title: string
  text: string
  retry?: () => void
}>

export function SelfHostedConnectionPanel(props: SelfHostedPanelProps) {
  const [setup, setSetup] = createSignal<'again' | 'new'>()
  const [notice, setNotice] = createSignal<Notice>()
  // Hosts whose revoke Adea accepted but a later read has not confirmed.
  const [unconfirmed, setUnconfirmed] = createSignal<readonly string[]>([])
  let generation = 0
  let addButton: HTMLButtonElement | undefined
  onCleanup(() => {
    generation += 1
  })

  // Authorization lost, or the list erased for a reset, leaves nothing the setup or the open
  // host was based on. Pairing values are secret and tied to the access that created them, so
  // they go with it; a transient refresh failure leaves the list ready and changes nothing here.
  createEffect(() => {
    if (props.hosts.state === 'ready') return
    setSetup(undefined)
    setNotice(undefined)
    setUnconfirmed([])
  })

  const nodes = (): readonly ApiRuntimeNode[] =>
    props.hosts.state === 'ready' ? props.hosts.nodes.filter((n) => n.kind === 'remote_host') : []
  const refreshing = () => props.hosts.state === 'ready' && props.hosts.refreshing === true
  const inspected = () => nodes().find((node) => node.id === props.inspectedId)
  const input = (node: ApiRuntimeNode): HostInput => ({
    node,
    discovery: props.discoveryFor(node.id),
    ...(props.requiredCapabilities ? { requiredCapabilities: props.requiredCapabilities } : {}),
  })

  /** Runs `work` for the scope that started it; a late result for another scope is dropped. */
  const guarded = async <T,>(work: () => Promise<T>): Promise<{ value: T } | { stale: true }> => {
    const scope = props.scope
    const mine = generation
    const value = await work()
    return mine !== generation || !sameScope(scope, props.scope) ? { stale: true } : { value }
  }

  const refresh = async () => {
    setNotice(undefined)
    const scope = props.scope
    try {
      await props.onRefreshHosts()
    } catch (error) {
      if (!sameScope(scope, props.scope)) return
      showFailure(classifyFailure(error, 'read'), () => void refresh())
    }
  }

  const closeSetup = () => {
    setSetup(undefined)
    queueMicrotask(() => addButton?.focus())
  }

  const showFailure = (failure: FailureGuidance, retry?: () => void) =>
    setNotice({
      tone: 'danger',
      title: failure.title,
      text: failure.guidance,
      ...(retry && (failure.retry === 'same' || failure.retry === 'refresh') ? { retry } : {}),
    })

  return (
    <div class="flex flex-col gap-2" data-testid="self-hosted-panel">
      <SettingsSection
        title="Self-hosted hosts"
        help="Servers you control that run work for this workspace. A host’s status never changes which conversation history you can read."
        bodyLayout="content"
        action={
          <Button
            ref={(element) => (addButton = element)}
            type="button"
            variant="outline"
            aria-disabled={props.hosts.state !== 'ready' || undefined}
            onClick={() => {
              if (props.hosts.state !== 'ready') return
              setNotice(undefined)
              setSetup('new')
            }}
          >
            Connect a host…
          </Button>
        }
      >
        <div class="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-disabled={props.hosts.state === 'loading' || refreshing() || undefined}
            onClick={() => {
              if (!(props.hosts.state === 'loading' || refreshing())) void refresh()
            }}
          >
            Refresh hosts
          </Button>
        </div>
        <Show when={notice()}>
          {(current) => (
            <Alert
              variant={current().tone === 'danger' ? 'destructive' : 'default'}
              role={current().tone === 'success' ? 'status' : 'alert'}
              data-testid="panel-notice"
              data-tone={current().tone}
            >
              <AlertTitle>{current().title}</AlertTitle>
              <AlertDescription>{current().text}</AlertDescription>
              <Show when={current().retry}>
                {(retry) => (
                  <div class="mt-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => retry()()}>
                      Try again
                    </Button>
                  </div>
                )}
              </Show>
            </Alert>
          )}
        </Show>
        <HostList
          chosenHostId={props.chosenHostId}
          hosts={props.hosts}
          inspectedId={props.inspectedId}
          input={input}
          nodes={nodes()}
          now={props.now}
          onInspect={props.onInspect}
          onRetry={() => void refresh()}
        />
      </SettingsSection>
      <Show when={setup()}>
        <Show
          when={props.slots?.SetupGuide}
          fallback={
            <SelfHostedSetupGuideShell
              reregistering={setup() === 'again'}
              onRefreshHosts={refresh}
              onClose={closeSetup}
              step2={<PairingUnavailable />}
            />
          }
        >
          {(SetupGuide) => (
            <Dynamic
              component={SetupGuide()}
              scope={props.scope}
              now={props.now}
              hostIds={nodes().map((node) => node.id)}
              openPairing={props.operations.openPairing}
              onRefreshHosts={refresh}
              reregistering={setup() === 'again'}
              onClose={closeSetup}
            />
          )}
        </Show>
      </Show>
      {/* Keyed by id, not by the node object: a refresh replaces the object but must not remount. */}
      <Show when={inspected()?.id} keyed>
        {(hostId) => (
          <Show when={inspected()}>
            {(current) => {
              const node = current
              return (
                <HostDetail
                  chosen={props.chosenHostId === hostId}
                  hosts={nodes()}
                  input={input(node())}
                  node={node()}
                  now={props.now}
                  unconfirmed={unconfirmed().includes(hostId)}
                  onChoose={props.onChooseHost}
                  onCheck={async () => {
                    setNotice(undefined)
                    const scope = props.scope
                    try {
                      await props.onCheckHost(hostId)
                    } catch (error) {
                      if (!sameScope(scope, props.scope)) return
                      showFailure(
                        classifyFailure(error, 'read'),
                        () => void props.onCheckHost(hostId)
                      )
                    }
                  }}
                  onRegisterAgain={() => {
                    setNotice(undefined)
                    setSetup('again')
                  }}
                  operations={props.operations}
                  guarded={guarded}
                  refreshHosts={props.onRefreshHosts}
                  currentHost={(id) => nodes().find((item) => item.id === id)}
                  notify={setNotice}
                  markUnconfirmed={(id, on) =>
                    setUnconfirmed(
                      on
                        ? [...new Set([...unconfirmed(), id])]
                        : unconfirmed().filter((item) => item !== id)
                    )
                  }
                  HostActions={props.slots?.HostActions}
                  onFailure={(failure, retry) => {
                    showFailure(failure, retry)
                    if (failure.retry === 'refresh') void props.onRefreshHosts()
                  }}
                />
              )
            }}
          </Show>
        )}
      </Show>
    </div>
  )
}

function HostList(props: {
  chosenHostId: string | undefined
  hosts: HostsRead
  inspectedId: string | undefined
  input: (node: ApiRuntimeNode) => HostInput
  nodes: readonly ApiRuntimeNode[]
  now: () => number
  onInspect: (hostId: string | undefined) => void
  onRetry: () => void
}) {
  // Rows keep their DOM (and focus) across refreshes that replace the node objects.
  const rows = keyedRows(
    () => props.nodes,
    (node) => node.id
  )
  return (
    <>
      <Show when={props.hosts.state === 'loading'}>
        <EmptyDescription role="status">Loading hosts…</EmptyDescription>
      </Show>
      <Show when={props.hosts.state === 'failed'}>
        <Alert variant="destructive" role="alert">
          <AlertTitle>Hosts could not be loaded</AlertTitle>
          <AlertDescription>
            The list is unknown right now, so no host is shown as connected or disconnected.
          </AlertDescription>
          <div class="mt-2">
            <Button type="button" size="sm" variant="outline" onClick={props.onRetry}>
              Try again
            </Button>
          </div>
        </Alert>
      </Show>
      <Show when={props.hosts.state === 'ready' && props.hosts.refreshing}>
        <EmptyDescription role="status">Refreshing hosts…</EmptyDescription>
      </Show>
      <Show when={props.hosts.state === 'ready' && props.hosts.refreshFailed}>
        <Alert role="alert" data-testid="refresh-failed">
          <AlertTitle>Hosts could not be refreshed</AlertTitle>
          <AlertDescription>
            Showing the last list that was read. Statuses may be out of date, and they keep aging
            while you look at them.
          </AlertDescription>
          <div class="mt-2">
            <Button type="button" size="sm" variant="outline" onClick={props.onRetry}>
              Try again
            </Button>
          </div>
        </Alert>
      </Show>
      <Show when={props.hosts.state === 'ready' && props.nodes.length === 0}>
        <EmptyDescription role="status">
          No self-hosted host is registered in this workspace. Connect one to run work on a server
          you control.
        </EmptyDescription>
      </Show>
      <Show when={props.nodes.length > 0}>
        <ul class="flex flex-col gap-2" aria-label="Self-hosted hosts">
          <For each={rows()}>
            {(entry) => {
              const node = entry.item
              const headline = createMemo(() => hostHeadline(props.input(node()), props.now()))
              return (
                <li
                  class="border-border bg-card flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
                  data-testid="host-row"
                  data-host-id={entry.key}
                >
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="truncate text-sm font-medium">{node().displayName}</span>
                    <span class="text-muted-foreground text-xs">{hostIdentityLabel(node())}</span>
                  </div>
                  <div class="flex flex-wrap items-center gap-3">
                    <Show when={props.chosenHostId === entry.key}>
                      <StatusChip tone="info" label="Chosen for new work" />
                    </Show>
                    <StatusChip tone={headline().tone} label={headline().label} />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Inspect ${node().displayName}, ${hostIdentityLabel(node())}`}
                      aria-pressed={props.inspectedId === entry.key}
                      onClick={() => props.onInspect(entry.key)}
                    >
                      Inspect
                    </Button>
                  </div>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    </>
  )
}

function AuthorityCard(props: { panel: AuthorityPanel }) {
  const panel = () => props.panel
  return (
    <section
      class="border-border bg-card flex flex-col gap-2 rounded-lg border p-4"
      aria-labelledby={`authority-${panel().id}`}
      data-testid={`authority-${panel().id}`}
      data-tone={panel().tone}
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`authority-${panel().id}`} class="text-sm font-medium">
          {panel().title}
        </h3>
        <StatusChip tone={panel().tone} label={panel().verdict} />
      </div>
      <p class="text-muted-foreground text-sm text-pretty">{panel().summary}</p>
      <dl class="grid gap-1 text-sm">
        <For each={panel().facts}>
          {(fact) => (
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-muted-foreground">{fact.label}</dt>
              <dd class="text-end">{fact.value}</dd>
            </div>
          )}
        </For>
      </dl>
      <ul class="text-muted-foreground list-disc ps-5 text-xs text-pretty">
        <For each={panel().boundaries}>{(item) => <li>{item}</li>}</For>
      </ul>
    </section>
  )
}

function HostDetail(props: {
  chosen: boolean
  guarded: <T>(work: () => Promise<T>) => Promise<{ value: T } | { stale: true }>
  hosts: readonly ApiRuntimeNode[]
  input: HostInput
  node: ApiRuntimeNode
  now: () => number
  onCheck: () => Promise<void>
  onChoose: ((hostId: string | undefined) => void) | undefined
  onFailure: (failure: FailureGuidance, retry?: () => void) => void
  onRegisterAgain: () => void
  operations: SelfHostedOperations
  refreshHosts: () => void | Promise<void>
  currentHost: (hostId: string) => ApiRuntimeNode | undefined
  notify: (notice: Notice) => void
  markUnconfirmed: (hostId: string, unconfirmed: boolean) => void
  HostActions: Component<HostActionsProps> | undefined
  unconfirmed: boolean
}) {
  const [checking, setChecking] = createSignal(false)
  let heading: HTMLHeadingElement | undefined

  const diagnostics = createMemo(() => diagnoseHost(props.input, props.now()))
  const steps = createMemo(() => remediationSteps(diagnostics()))
  const selectable = createMemo(() => hostSelectability(props.input, props.now()))
  const revoked = () => diagnostics().find((item) => item.id === 'registration')?.tone === 'danger'

  const check = async () => {
    if (checking()) return
    setChecking(true)
    try {
      await props.onCheck()
    } finally {
      setChecking(false)
    }
  }

  const needsReconnect = () =>
    !revoked() && diagnostics().some((item) => item.action === 'reconnect_location')

  return (
    <>
      <SettingsSection
        title={props.node.displayName}
        description={hostIdentityLabel(props.node)}
        bodyLayout="content"
        aria-label={`${props.node.displayName} details`}
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={revoked()}
            aria-disabled={checking() || undefined}
            onClick={() => void check()}
          >
            {checking() ? 'Checking…' : needsReconnect() ? 'Reconnect check' : 'Check again'}
          </Button>
        }
      >
        <h3
          ref={(element) => (heading = element)}
          tabindex="-1"
          class="text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          data-testid="host-detail-heading"
        >
          Details for {props.node.displayName}
        </h3>
        <Show when={props.unconfirmed && !revoked()}>
          <Alert role="alert" data-testid="unconfirmed-revocation">
            <AlertTitle>Revocation not confirmed</AlertTitle>
            <AlertDescription>
              Adea accepted a revoke for this host, but the latest read still shows it registered.
              Check again before relying on either state.
            </AlertDescription>
          </Alert>
        </Show>
        <div class="grid gap-3 md:grid-cols-2" data-testid="authorities">
          <AuthorityCard panel={executionAuthority(props.input, props.now())} />
          <AuthorityCard panel={historyAuthority()} />
        </div>
        <ul class="flex flex-col" aria-label="Checks" data-testid="diagnostics">
          <For each={diagnostics()}>
            {(item) => (
              <li class="border-border flex flex-col gap-1 border-t py-3 first:border-t-0">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="text-sm font-medium">{item.label}</span>
                  <StatusChip tone={item.tone} label={item.verdict} />
                </div>
                <p class="text-muted-foreground text-sm text-pretty">{item.detail}</p>
              </li>
            )}
          </For>
        </ul>
        <Show when={steps().length > 0}>
          <div class="flex flex-col gap-1" data-testid="next-steps">
            <h3 class="text-sm font-medium">What to do next</h3>
            <ul class="text-muted-foreground list-disc ps-5 text-sm text-pretty">
              <For each={steps()}>{(step) => <li>{step}</li>}</For>
            </ul>
          </div>
        </Show>
      </SettingsSection>
      <SettingsSection title="Manage this host" bodyLayout="content">
        <SettingsRow
          label="Use for new work"
          description={
            props.chosen
              ? 'New work is directed here. Adea never falls back to another host, and checks this one again at submission.'
              : 'Pick this host on purpose. Adea never chooses between hosts for you.'
          }
        >
          <Button
            type="button"
            variant={props.chosen ? 'secondary' : 'outline'}
            disabled={!props.onChoose || (!props.chosen && (!selectable().allowed || revoked()))}
            aria-pressed={props.chosen}
            aria-describedby="choose-reason"
            onClick={() => props.onChoose?.(props.chosen ? undefined : props.node.id)}
          >
            {props.chosen ? 'Stop using this host' : 'Use this host'}
          </Button>
        </SettingsRow>
        <p
          id="choose-reason"
          class="text-muted-foreground text-sm text-pretty"
          data-testid="choose-reason"
        >
          <Show
            when={props.onChoose}
            fallback="Not available yet: choosing a host is not connected in this build."
          >
            <Show
              when={!revoked()}
              fallback={
                props.chosen
                  ? 'This host is still chosen but its execution was revoked, so Adea will not send it work. Stop using it to clear the choice.'
                  : 'A revoked host cannot be chosen.'
              }
            >
              <Show
                when={props.chosen && !selectable().allowed}
                fallback={
                  selectable().allowed
                    ? 'Every check Adea can make passed. Admission is checked again when work is submitted.'
                    : `Not selectable yet. ${selectable().blockers.join('; ')}.`
                }
              >
                This host is still chosen, but it would not pass today’s checks:{' '}
                {selectable().blockers.join('; ')}. New work will wait or be refused rather than
                move to another host.
              </Show>
            </Show>
          </Show>
        </p>
        <Show
          when={props.HostActions}
          fallback={<LeanHostActions revoked={revoked()} onRegisterAgain={props.onRegisterAgain} />}
        >
          {(Actions) => (
            <Dynamic
              component={Actions()}
              node={props.node}
              hosts={props.hosts}
              revoked={revoked()}
              operations={props.operations}
              guarded={props.guarded}
              focusHeading={() => heading?.focus()}
              refreshHosts={props.refreshHosts}
              currentHost={props.currentHost}
              notify={props.notify}
              markUnconfirmed={props.markUnconfirmed}
              onFailure={props.onFailure}
              onRegisterAgain={props.onRegisterAgain}
            />
          )}
        </Show>
      </SettingsSection>
    </>
  )
}

/** Name and revoke when neither operation is connected: the controls stay, disabled, with the reason. */
function LeanHostActions(props: { revoked: boolean; onRegisterAgain: () => void }) {
  return (
    <>
      <SettingsRow label="Name" description="Names must stay distinct so hosts are never confused.">
        <Button type="button" variant="outline" disabled aria-describedby="rename-reason">
          Rename…
        </Button>
      </SettingsRow>
      <p id="rename-reason" class="text-muted-foreground text-sm text-pretty">
        Not available yet: the server has no rename operation. The name is set by the host when it
        registers.
      </p>
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
          <Button type="button" variant="outline" disabled aria-describedby="revoke-reason">
            Revoke execution…
          </Button>
        </Show>
      </SettingsRow>
      <Show when={!props.revoked}>
        <p id="revoke-reason" class="text-muted-foreground text-sm text-pretty">
          Not available yet: revoking is not connected in this build.
        </p>
      </Show>
    </>
  )
}
