import type {
  ApiLeadTurnStatus,
  ApiLeadTurnProgressResponse,
  ApiLeadTurnResponse,
} from '@adea-ai/api-client'
import type {
  ApiModelFundingView,
  ApiModelFundingBinding,
} from '@adea-ai/api-client/model-connections'
import { projectModelFunding, type ProjectedModelFunding } from './lead-model-state'

export type LeadTurnScope = Readonly<{
  workspaceId: string
  channelId: string
  audienceEpoch: number
}>
export type LeadTurnView = Readonly<{
  turn: ApiLeadTurnStatus | null
  funding: ProjectedModelFunding | null
  loading: boolean
  busy: boolean
  cursor: number
  notice: string | null
  requiresNewAdmission: boolean
}>
export type LeadTurnPort = Readonly<{
  latest: (scope: LeadTurnScope) => Promise<{ leadTurn: ApiLeadTurnStatus | null }>
  status: (scope: LeadTurnScope, intentId: string) => Promise<ApiLeadTurnResponse>
  progress: (
    scope: LeadTurnScope,
    intentId: string,
    cursor: number
  ) => Promise<ApiLeadTurnProgressResponse>
  prepare?: (scope: LeadTurnScope, intentId: string) => Promise<ApiLeadTurnResponse>
  funding: (
    scope: LeadTurnScope,
    binding: ApiModelFundingBinding
  ) => Promise<{ funding: ApiModelFundingView }>
  start: (scope: LeadTurnScope, intentId: string) => Promise<ApiLeadTurnResponse>
  cancel: (scope: LeadTurnScope, intentId: string) => Promise<ApiLeadTurnResponse>
}>

const empty = (): LeadTurnView => ({
  turn: null,
  funding: null,
  loading: false,
  busy: false,
  cursor: 0,
  notice: null,
  requiresNewAdmission: false,
})
const cancellable = new Set(['starting', 'running', 'awaiting_input', 'cancelling'])
const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out'])

export function leadPreparationCurrent(turn: ApiLeadTurnStatus | null, now: number): boolean {
  const expiry = turn?.preparationExpiresAt
  if (
    !/^prep_[a-f0-9]{32}$/.test(turn?.preparationRef ?? '') ||
    !expiry ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiry)
  )
    return false
  const parsed = Date.parse(expiry)
  return (
    Number.isFinite(parsed) &&
    parsed > now &&
    new Date(parsed).toISOString().slice(0, 19) === expiry.slice(0, 19)
  )
}

export function leadFundingBinding(
  turn: ApiLeadTurnStatus | null
): ApiModelFundingBinding | undefined {
  if (
    !turn?.executionId ||
    !turn.attemptId ||
    !turn.selectionRef ||
    turn.selectionRevision === undefined
  )
    return undefined
  return {
    executionId: turn.executionId,
    attemptId: turn.attemptId,
    selectionRef: turn.selectionRef,
    selectionRevision: turn.selectionRevision,
  }
}

/** Owns view state only. Canonical intent/execution/session authority stays on the server. */
export function createLeadTurnViewController(options: {
  scope: () => LeadTurnScope
  port: LeadTurnPort
  changed: (view: LeadTurnView) => void
  now?: () => number
}) {
  let generation = 0
  let view = empty()
  let disposed = false
  const now = options.now ?? Date.now
  const update = (patch: Partial<LeadTurnView>) => {
    view = { ...view, ...patch }
    options.changed(view)
  }
  const capture = () => ({ ...options.scope(), generation })
  const current = (scope: ReturnType<typeof capture>) => {
    const active = options.scope()
    return (
      !disposed &&
      scope.generation === generation &&
      scope.workspaceId === active.workspaceId &&
      scope.channelId === active.channelId &&
      scope.audienceEpoch === active.audienceEpoch
    )
  }
  const accepts = (turn: ApiLeadTurnStatus, intentId: string) =>
    turn.schemaVersion === 'adea-lead-turn/v1' &&
    turn.intentId === intentId &&
    turn.messageId === view.turn?.messageId
  const accept = (turn: ApiLeadTurnStatus) => update({ turn, funding: null })
  const fail = () =>
    update({
      funding: null,
      notice: 'Lead status is unavailable. Your saved message and draft are preserved.',
    })

  async function refresh() {
    if (view.loading || view.busy || disposed) return
    const scope = capture()
    update({ loading: true, funding: null, notice: null })
    try {
      if (!view.turn) {
        const result = await options.port.latest(scope)
        if (!current(scope)) return
        update({ turn: result.leadTurn, cursor: 0 })
      }
      const turn = view.turn
      if (!turn) return
      const result = await options.port.status(scope, turn.intentId)
      if (!current(scope)) return
      if (!accepts(result.leadTurn, turn.intentId)) {
        fail()
        return
      }
      update({ turn: result.leadTurn })
      if (result.leadTurn.dispatchId) {
        const progress = await options.port.progress(scope, turn.intentId, view.cursor)
        if (!current(scope)) return
        if (
          !accepts(progress.leadTurn, turn.intentId) ||
          !Number.isSafeInteger(progress.nextSequence) ||
          progress.nextSequence < view.cursor
        ) {
          fail()
          return
        }
        update({ turn: progress.leadTurn, cursor: progress.nextSequence })
      }
      const binding = leadFundingBinding(view.turn)
      if (
        binding &&
        (view.turn?.state !== 'prepared' || leadPreparationCurrent(view.turn, now()))
      ) {
        const fundingResponse = await options.port.funding(scope, binding)
        if (!current(scope)) return
        const funding = projectModelFunding(
          fundingResponse.funding,
          { workspaceId: scope.workspaceId, ...binding },
          { current: true, now: now() }
        )
        update({ funding })
      }
    } catch {
      if (current(scope)) fail()
    } finally {
      if (current(scope)) update({ loading: false })
    }
  }

  async function prepare() {
    const turn = view.turn
    if (
      !turn ||
      view.busy ||
      view.loading ||
      !options.port.prepare ||
      view.requiresNewAdmission ||
      turn.dispatchId ||
      (turn.state === 'prepared' && !leadPreparationCurrent(turn, now())) ||
      (turn.state !== 'blocked' && turn.state !== 'prepared')
    )
      return
    const scope = capture()
    update({ busy: true, funding: null, notice: null })
    try {
      const result = await options.port.prepare(scope, turn.intentId)
      if (!current(scope)) return
      if (!accepts(result.leadTurn, turn.intentId)) {
        fail()
        return
      }
      accept(result.leadTurn)
    } catch {
      if (current(scope)) fail()
    } finally {
      if (current(scope)) update({ busy: false })
    }
    if (current(scope)) await refresh()
  }

  async function start(confirmedFunding: ApiModelFundingView) {
    const turn = view.turn
    const binding = leadFundingBinding(turn)
    if (
      !turn ||
      !binding ||
      view.busy ||
      view.loading ||
      view.requiresNewAdmission ||
      !leadPreparationCurrent(turn, now()) ||
      confirmedFunding.state !== 'ready' ||
      turn.availability !== 'available' ||
      turn.state !== 'prepared' ||
      turn.dispatchId ||
      terminal.has(turn.state)
    )
      return
    const scope = capture()
    const displayed = projectModelFunding(
      confirmedFunding,
      { workspaceId: scope.workspaceId, ...binding },
      { current: true, now: now() }
    )
    if (displayed.state !== 'ready') return
    update({ busy: true, notice: null })
    try {
      // Re-read the exact recorded payer before explicit start. Changed payer,
      // authorization, model, revision or expiry requires a new disclosure.
      const result = await options.port.funding(scope, binding)
      if (!current(scope)) return
      if (!leadPreparationCurrent(turn, now())) {
        update({
          funding: null,
          notice:
            'Preparation expired. Model work was not started; refresh the existing admission.',
        })
        return
      }
      const fresh = projectModelFunding(
        result.funding,
        { workspaceId: scope.workspaceId, ...binding },
        { current: true, now: now() }
      )
      if (fresh.state !== 'ready' || JSON.stringify(fresh) !== JSON.stringify(displayed)) {
        update({
          funding: fresh,
          requiresNewAdmission: true,
          notice:
            'Model or payer authorization changed. This attempt remains blocked. A new canonical admission is required; retry controls are not yet available.',
        })
        return
      }
      const started = await options.port.start(scope, turn.intentId)
      if (!current(scope)) return
      if (!accepts(started.leadTurn, turn.intentId)) {
        fail()
        return
      }
      accept(started.leadTurn)
    } catch {
      if (current(scope)) fail()
    } finally {
      if (current(scope)) update({ busy: false })
    }
  }

  async function cancel() {
    const turn = view.turn
    if (!turn || view.busy || !cancellable.has(turn.state)) return
    const scope = capture()
    update({ busy: true, notice: null })
    try {
      const result = await options.port.cancel(scope, turn.intentId)
      if (!current(scope)) return
      if (!accepts(result.leadTurn, turn.intentId)) {
        fail()
        return
      }
      accept(result.leadTurn)
    } catch {
      if (current(scope)) fail()
    } finally {
      if (current(scope)) update({ busy: false })
    }
  }

  return {
    get view() {
      return view
    },
    refresh,
    prepare,
    start,
    cancel,
    canCancel: () => Boolean(view.turn && cancellable.has(view.turn.state) && !view.busy),
    reset: (turn: ApiLeadTurnStatus | null = null) => {
      generation += 1
      view = { ...empty(), turn }
      options.changed(view)
    },
    dispose: () => {
      disposed = true
      generation += 1
    },
  }
}
