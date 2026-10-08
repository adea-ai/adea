import type { AgentHqApiClient, ApiLeadTurnStatus } from '@adea-ai/api-client'
import type { ApiModelFundingView } from '@adea-ai/api-client/model-connections'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import {
  createLeadTurnViewController,
  leadFundingBinding,
  leadPreparationCurrent,
  type LeadTurnView,
} from './lead-turn-state'
import { projectModelFunding } from './lead-model-state'
import { leadTurnPresentation } from './lead-turn-presentation'

/** Displays canonical observations. Reads never start inference or take over a native session. */
export function LeadTurnControls(props: {
  client: AgentHqApiClient
  workspaceId: string
  channelId: string
  audienceEpoch: number
  receipt?: ApiLeadTurnStatus | null
  onTimelineChange: () => void
}) {
  const [view, setView] = createSignal<LeadTurnView>({
    turn: null,
    funding: null,
    cursor: 0,
    loading: false,
    busy: false,
    notice: null,
    requiresNewAdmission: false,
  })
  const [confirmed, setConfirmed] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const controller = createLeadTurnViewController({
    scope: () => ({
      workspaceId: props.workspaceId,
      channelId: props.channelId,
      audienceEpoch: props.audienceEpoch,
    }),
    changed: setView,
    port: {
      latest: (scope) => props.client.getChannelLeadTurn(scope.workspaceId, scope.channelId),
      status: (scope, intentId) => props.client.getLeadTurnStatus(scope.workspaceId, intentId),
      progress: (scope, intentId, cursor) =>
        props.client.getLeadTurnProgress(scope.workspaceId, intentId, cursor),
      prepare: (scope, intentId) => props.client.prepareLeadTurn(scope.workspaceId, intentId),
      funding: (scope, binding) =>
        props.client.getModelSelectionFunding(scope.workspaceId, binding),
      start: (scope, intentId) => props.client.dispatchLeadTurn(scope.workspaceId, intentId),
      cancel: (scope, intentId) => props.client.cancelLeadTurn(scope.workspaceId, intentId),
    },
  })
  createEffect(() => {
    void props.workspaceId
    void props.channelId
    void props.audienceEpoch
    controller.reset(props.receipt ?? null)
    setConfirmed(false)
    void controller.refresh()
  })
  const funding = createMemo(() => {
    const binding = leadFundingBinding(view().turn)
    if (!binding) return null
    return projectModelFunding(
      view().funding,
      { workspaceId: props.workspaceId, ...binding },
      {
        current:
          !view().loading &&
          !view().busy &&
          (view().turn?.state !== 'prepared' || leadPreparationCurrent(view().turn, now())),
        now: now(),
      }
    )
  })
  const readyFunding = () => {
    const value = funding()
    return value?.state === 'ready' ? value : undefined
  }
  const preparationCurrent = () => {
    return leadPreparationCurrent(view().turn, now())
  }
  const presentation = createMemo(() => leadTurnPresentation(view().turn, preparationCurrent()))
  createEffect(() => {
    const disclosure = readyFunding()
    const preparationExpiry = Date.parse(view().turn?.preparationExpiresAt ?? '')
    const deadlines = [
      disclosure ? Date.parse(disclosure.expiresAt) : NaN,
      preparationExpiry,
    ].filter((deadline) => Number.isFinite(deadline) && deadline > now())
    if (!deadlines.length) return
    const deadline = Math.min(...deadlines)
    const timer = setTimeout(
      () => {
        setNow(Date.now())
        setConfirmed(false)
      },
      Math.min(deadline - Date.now(), 2_147_483_647)
    )
    onCleanup(() => clearTimeout(timer))
  })
  let disclosureKey = ''
  createEffect(() => {
    const next = JSON.stringify(funding())
    if (next !== disclosureKey) {
      disclosureKey = next
      setConfirmed(false)
    }
  })
  let lastPublished: string | undefined
  createEffect(() => {
    const published = view().turn?.publishedMessageId
    if (!published || published === lastPublished) return
    lastPublished = published
    props.onTimelineChange()
  })
  onMount(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      const state = view().turn?.state
      if (
        state === 'starting' ||
        state === 'running' ||
        state === 'awaiting_input' ||
        state === 'cancelling' ||
        state === 'dispatch_pending'
      )
        void controller.refresh()
    }, 5_000)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(controller.dispose)
  const canStart = () =>
    view().turn?.state === 'prepared' &&
    view().turn?.availability === 'available' &&
    preparationCurrent() &&
    funding()?.state === 'ready' &&
    confirmed() &&
    !view().busy &&
    !view().loading &&
    !view().requiresNewAdmission
  const start = async () => {
    const current = funding()
    if (!canStart() || current?.state !== 'ready') return
    setConfirmed(false)
    await controller.start(current as Extract<ApiModelFundingView, { state: 'ready' }>)
  }
  return (
    <section aria-label="Workspace lead turn" class="flex flex-col gap-2 px-5 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{presentation().label}</Badge>
        <Button
          size="sm"
          variant="outline"
          disabled={view().loading || view().busy}
          onClick={() => void controller.refresh()}
        >
          Refresh lead status
        </Button>
        <Show
          when={
            !view().turn?.dispatchId &&
            !view().requiresNewAdmission &&
            (view().turn?.state !== 'prepared' || preparationCurrent()) &&
            (view().turn?.state === 'blocked' || view().turn?.state === 'prepared')
          }
        >
          <Button
            size="sm"
            variant="outline"
            disabled={view().loading || view().busy}
            onClick={() => void controller.prepare()}
          >
            Review model and payer
          </Button>
        </Show>
        <Show when={controller.canCancel()}>
          <Button
            size="sm"
            variant="outline"
            disabled={view().busy}
            onClick={() => void controller.cancel()}
          >
            Request cancellation
          </Button>
        </Show>
      </div>
      <Show when={view().notice}>
        {(message) => <EmptyDescription role="status">{message()}</EmptyDescription>}
      </Show>
      <Show when={view().requiresNewAdmission}>
        <EmptyDescription role="status">
          Model or payer authorization changed. This attempt cannot switch payer. A fresh canonical
          admission is required after cancellation or expiry; retry controls are not yet connected.
          Your saved message and draft are preserved.
        </EmptyDescription>
      </Show>
      <Show when={view().turn?.state === 'prepared' && !preparationCurrent()}>
        <EmptyDescription role="status">
          Preparation expired. This turn cannot start. Refresh its status; a fresh-turn retry is not
          yet connected. Your saved message and draft are preserved.
        </EmptyDescription>
      </Show>
      <Show when={view().turn?.state === 'dispatch_pending' && !view().turn?.dispatchId}>
        <EmptyDescription role="status">
          Dispatch acknowledgement is unresolved. Refresh checks the existing receipt when recovery
          is connected; it does not restart model work or create another attempt.
        </EmptyDescription>
      </Show>
      <Show when={!view().turn}>
        <EmptyDescription>
          Save a message to prepare a lead turn. Model work starts only after a current model and
          payer review. Independent direct sessions remain available.
        </EmptyDescription>
      </Show>
      <Show when={presentation().notice}>
        {(notice) => <EmptyDescription role="status">{notice().text}</EmptyDescription>}
      </Show>
      <Show when={funding()}>
        <Show
          when={readyFunding()}
          fallback={
            <EmptyDescription role="status">
              Current payer authorization is unavailable. Refresh and review model setup before
              starting.
            </EmptyDescription>
          }
        >
          {(value) => (
            <div class="flex flex-col gap-1" aria-label="Current model and payer">
              <p>
                Provider: {value().provider} · Model: {value().providerModel}
              </p>
              <p>
                Account: {value().accountRef} · Authentication: {value().authKind}
              </p>
              <p>
                Funding: {value().fundingSource} · Payer: {value().fundingOwner.displayName} (
                {value().fundingOwner.kind}, {value().fundingOwner.ownerRef})
              </p>
              <p>Authorization expires: {value().expiresAt}</p>
              <Show when={view().turn?.state === 'prepared' && !view().requiresNewAdmission}>
                <Button
                  size="sm"
                  variant="outline"
                  aria-pressed={confirmed()}
                  disabled={view().loading || view().busy}
                  onClick={() => setConfirmed(!confirmed())}
                >
                  {confirmed() ? 'Payer reviewed' : 'Confirm this model and payer'}
                </Button>
                <Button size="sm" disabled={!canStart()} onClick={() => void start()}>
                  Start lead turn
                </Button>
              </Show>
            </div>
          )}
        </Show>
      </Show>
      <Show when={view().turn?.state === 'cancelling'}>
        <EmptyDescription role="status">
          Cancellation is requested. The outcome and any provider charge remain unconfirmed until
          the runtime reports them.
        </EmptyDescription>
      </Show>
      <Show when={view().turn?.state === 'awaiting_input'}>
        <EmptyDescription role="status">
          The lead is waiting for input. Approval actions remain unavailable until the governed
          interaction API is connected.
        </EmptyDescription>
      </Show>
      <Show when={view().turn?.state === 'unknown'}>
        <EmptyDescription role="status">
          Execution status is unknown. Refresh the existing turn; do not resubmit it to infer a new
          outcome.
        </EmptyDescription>
      </Show>
    </section>
  )
}
